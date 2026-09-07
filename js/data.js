const HALVING_DATES = [
    new Date('2012-11-28'),
    new Date('2016-07-09'),
    new Date('2020-05-11'),
    new Date('2024-04-19'),
];

const NEXT_HALVING_ESTIMATE = new Date('2028-04-01');

// 四年大周期 = 3年涨 + 1年跌 的日历年模型（参考文档四年大周期图）
// year % 4: 0 = 减半年/首轮牛, 1 = 次轮牛(顶部年), 2 = 熊年, 3 = 预备牛
const CYCLE_YEAR_PHASES = {
    0: { key: '1st-bull', name: '首轮牛市', color: '#14b8a6', desc: '减半年，牛市启动，趋势通常向上' },
    1: { key: '2nd-bull', name: '次轮牛市/顶部', color: '#22c55e', desc: '牛市延续与见顶年，注意周期顶部风险' },
    2: { key: 'bear', name: '熊市回调', color: '#ef4444', desc: '主要下跌年，历史上此阶段承压筑底' },
    3: { key: 'pre-bull', name: '预备牛市', color: '#3b82f6', desc: '筑底与复苏年，为下一轮减半牛蓄势' },
};

const DataModule = {
    rawData: [],
    processedData: [],
    onchainData: [],   // [{date, mvrv, realizedPrice}] 升序
    etfData: [],       // [{date, flow, cumulative}] 升序，flow 单位百万美元
    btcAaplData: [],   // [{date, aapl, btc, ratio}] 升序
    dominanceData: [], // [{date, btcD, usdtD}] 升序，百分比值
    _mvrvBands: null,

    // 缓存击穿参数：精确到小时，确保本地开发和 Actions 更新后都能拿到最新数据
    _cacheBust() {
        const d = new Date();
        return '?v=' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + String(d.getUTCHours()).padStart(2, '0');
    },

    async loadCSV() {
        try {
            const response = await fetch('data/btc_historical.csv' + this._cacheBust());
            const text = await response.text();
            this.rawData = this.parseCSV(text);
            this.processedData = this.rawData.sort((a, b) => a.date - b.date);
            return this.processedData;
        } catch (e) {
            console.error('Failed to load CSV:', e);
            return [];
        }
    },

    // 加载链上 CSV（MVRV Ratio + Realized Price + NUPL），按日期 join。格式：逗号分隔、降序、
    // 首行表头、日期形如 2026-07-15T00:00:00Z。缺 MVRV/Realized 的日期跳过；NUPL 可缺（null）。
    async loadOnchainCSV() {
        try {
            const [mvrvText, rpText, nuplText] = await Promise.all([
                fetch('data/mvrv.csv' + this._cacheBust()).then(r => r.text()),
                fetch('data/realized_price.csv' + this._cacheBust()).then(r => r.text()),
                fetch('data/nupl.csv' + this._cacheBust()).then(r => r.text()).catch(() => ''),
            ]);
            const mvrv = this._parseOnchainCol(mvrvText);
            const rp = this._parseOnchainCol(rpText);
            const nupl = this._parseOnchainCol(nuplText);
            // 价格查表：realized_price.csv 起点较晚（2014-11），早期缺失时用 price/mvrv 反推，
            // 使链上指标（MVRV 带、R/R）可回溯到 MVRV 有值的最早日（2010-07）。
            const priceByDay = new Map();
            for (const d of this.processedData) priceByDay.set(d.date.toISOString().slice(0, 10), d.close);
            // 2009-2010 早期 BTC 几乎无市场，MVRV 为无意义的极端值（如 443、12.9），会让
            // expanding 均值/标准差爆炸、-1.0sd 变负数、对数图出现畸形尖峰。从 2011-01-01 起才纳入。
            const ONCHAIN_START = '2011-01-01';
            const merged = [];
            for (const [day, m] of mvrv) {
                if (day < ONCHAIN_START) continue;
                let r = rp.get(day);
                if (r == null) {
                    const px = priceByDay.get(day);
                    if (px != null && m) r = px / m;  // 反推已实现价格
                }
                if (r == null) continue;  // 既无 CSV 值也无价格可推，跳过
                merged.push({ date: new Date(day), mvrv: m, realizedPrice: r, nupl: nupl.has(day) ? nupl.get(day) : null });
            }
            this.onchainData = merged.sort((a, b) => a.date - b.date);
            this._mvrvBands = null; // 失效重算
            this._riskReward = null;
            return this.onchainData;
        } catch (e) {
            console.warn('Failed to load on-chain CSV:', e.message);
            this.onchainData = [];
            return [];
        }
    },

    // 加载 ETF 每日净流量 CSV（data/etf_flow.csv，单位百万美元），并算累计净流入。
    async loadEtfCSV() {
        try {
            const text = await fetch('data/etf_flow.csv' + this._cacheBust()).then(r => r.text());
            const map = this._parseOnchainCol(text);
            const rows = Array.from(map.entries())
                .map(([day, flow]) => ({ date: new Date(day), flow }))
                .sort((a, b) => a.date - b.date);
            let cum = 0;
            for (const r of rows) { cum += r.flow; r.cumulative = cum; }
            // 近 20 日滚动净流入（平滑日噪声；其正负是最有区分力的资金环境信号）
            for (let i = 0; i < rows.length; i++) {
                let s = 0, cnt = 0;
                for (let j = Math.max(0, i - 19); j <= i; j++) { s += rows[j].flow; cnt++; }
                rows[i].roll20 = s;
            }
            this.etfData = rows;
            return rows;
        } catch (e) {
            console.warn('Failed to load ETF CSV:', e.message);
            this.etfData = [];
            return [];
        }
    },

    // 加载 BTC/AAPL 比率 CSV（data/btc_aapl.csv）。
    // 格式：Datetime,AAPL Close,BTC Close,BTC/AAPL Ratio。降序。
    async loadBtcAaplCSV() {
        try {
            const text = await fetch('data/btc_aapl.csv' + this._cacheBust()).then(r => r.text());
            const lines = text.trim().split('\n');
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',');
                if (cols.length < 4) continue;
                const day = cols[0].trim().slice(0, 10);
                const aapl = parseFloat(cols[1]);
                const btc = parseFloat(cols[2]);
                const ratio = parseFloat(cols[3]);
                if (!day || isNaN(ratio)) continue;
                rows.push({ date: new Date(day), aapl, btc, ratio });
            }
            this.btcAaplData = rows.sort((a, b) => a.date - b.date);
            return this.btcAaplData;
        } catch (e) {
            console.warn('Failed to load BTC/AAPL CSV:', e.message);
            this.btcAaplData = [];
            return [];
        }
    },

    // 加载 BTC.D / USDT.D 市占率 CSV（data/dominance.csv）。
    // 格式：Datetime,BTC.D,USDT.D。降序。百分比值（如 59.65, 7.02）。
    async loadDominanceCSV() {
        try {
            const text = await fetch('data/dominance.csv' + this._cacheBust()).then(r => r.text());
            const lines = text.trim().split('\n');
            const rows = [];
            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',');
                if (cols.length < 3) continue;
                const day = cols[0].trim().slice(0, 10);
                const btcD = parseFloat(cols[1]);
                const usdtD = parseFloat(cols[2]);
                if (!day || isNaN(btcD)) continue;
                rows.push({ date: new Date(day), btcD, usdtD: isNaN(usdtD) ? null : usdtD });
            }
            this.dominanceData = rows.sort((a, b) => a.date - b.date);
            return this.dominanceData;
        } catch (e) {
            console.warn('Failed to load dominance CSV:', e.message);
            this.dominanceData = [];
            return [];
        }
    },

    // 加载 URPD CSV（data/urpd.csv）。
    // 格式：date,band,label,supply,cost_basis,profit_percent,supply_percent,supply_usd,
    //        realized_cap_usd,realized_cap_percent,utxo_count。降序，每天 ~13 行，365 天历史。
    // 返回 { dates, byDate, latest }，latest 是最新一天的快照。
    async loadUrpdCSV() {
        try {
            const text = await fetch('data/urpd.csv' + this._cacheBust()).then(r => r.text());
            const lines = text.trim().split('\n');
            if (lines.length < 2) { this.urpdData = null; return null; }

            const byDate = {};  // { 'YYYY-MM-DD': { profitPercent, bands: [...] } }
            const dateOrder = []; // 降序日期列表

            for (let i = 1; i < lines.length; i++) {
                const cols = lines[i].split(',');
                if (cols.length < 6) continue;
                const day = cols[0].trim().slice(0, 10);
                if (!day) continue;

                if (!byDate[day]) {
                    byDate[day] = { profitPercent: null, bands: [] };
                    dateOrder.push(day);
                }

                const entry = byDate[day];
                const supply = parseFloat(cols[3]);
                const costBasis = parseFloat(cols[4]);
                if (isNaN(supply) || isNaN(costBasis)) continue;

                const pp = parseFloat(cols[5]);
                if (entry.profitPercent === null && !isNaN(pp)) entry.profitPercent = pp;

                const band = {
                    band: cols[1].trim(),
                    label: cols[2].trim(),
                    supply,
                    costBasis,
                    supplyPercent: parseFloat(cols[6]) || null,
                    supplyUsd: parseFloat(cols[7]) || null,
                    realizedCapUsd: parseFloat(cols[8]) || null,
                    realizedCapPercent: parseFloat(cols[9]) || null,
                    utxoCount: parseInt(cols[10]) || null,
                };
                entry.bands.push(band);
            }

            // 每天的 bands 按成本基础升序
            for (const day of dateOrder) {
                byDate[day].bands.sort((a, b) => a.costBasis - b.costBasis);
            }

            const currentPrice = this.processedData.length
                ? this.processedData[this.processedData.length - 1].close
                : null;

            const latestDate = dateOrder[0];
            const latest = latestDate ? {
                date: latestDate,
                profitPercent: byDate[latestDate].profitPercent,
                currentPrice,
                bands: byDate[latestDate].bands,
            } : null;

            this.urpdData = dateOrder.length ? { dates: dateOrder, byDate, latest, currentPrice } : null;
            return this.urpdData;
        } catch (e) {
            console.warn('Failed to load URPD CSV:', e.message);
            this.urpdData = null;
            return null;
        }
    },

    // 解析「Datetime,Value」两列 CSV，返回 Map<YYYY-MM-DD, number>（跳过空值）
    _parseOnchainCol(text) {
        const map = new Map();
        const lines = text.trim().split('\n');
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length < 2) continue;
            const day = cols[0].trim().slice(0, 10);
            const v = parseFloat(cols[1]);
            if (!day || isNaN(v)) continue;
            map.set(day, v);
        }
        return map;
    },

    parseCSV(text) {
        const lines = text.trim().split('\n');
        const data = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(';');
            if (cols.length < 12) continue;
            const dateStr = cols[0].replace(/"/g, '');
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) continue;
            data.push({
                date,
                open: parseFloat(cols[5]),
                high: parseFloat(cols[6]),
                low: parseFloat(cols[7]),
                close: parseFloat(cols[8]),
                volume: parseFloat(cols[9]),
                marketCap: parseFloat(cols[10]),
                supply: parseFloat(cols[11]),
            });
        }
        return data;
    },

    getLatest() {
        if (!this.processedData.length) return null;
        return this.processedData[this.processedData.length - 1];
    },

    // 实时价（fetchLivePrice 成功后由 app.js 写入）；拿不到时为 null。
    livePrice: null,

    // 统一的「当前价」入口：优先实时价，回退 CSV 最新收盘价。
    // 概览卡与周报分析文字都应经此取价，避免两者口径不一致。
    getCurrentPrice() {
        if (this.livePrice != null && isFinite(this.livePrice) && this.livePrice > 0) return this.livePrice;
        const latest = this.getLatest();
        return latest ? latest.close : null;
    },

    getDataForPeriod(days) {
        if (days === 'all') return this.processedData;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        return this.processedData.filter(d => d.date >= cutoff);
    },

    calculateMA(data, period) {
        const result = [];
        for (let i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else {
                let sum = 0;
                for (let j = i - period + 1; j <= i; j++) {
                    sum += data[j].close;
                }
                result.push(sum / period);
            }
        }
        return result;
    },

    // ===== zZ 指标：MA6 / MA103 / MA110 + 假设价格不变的延长线与交叉信号 =====
    // 逻辑：从今天起假设 BTC 价格恒定 = 当前价，逐日把每条 MA 窗口最旧一天替换成当前价，
    // 模拟未来 MA 走向；据此求两组交叉：
    //   ① 价格上穿 MA110 → 上涨/牛市启动信号
    //   ② MA6 上穿 MA103（金叉）→ 买入信号
    // 返回当前值、各 MA 的未来延长序列、以及两组交叉的天数/日期。
    ZZ_PERIODS: [6, 103, 110],
    ZZ_MAX_PROJECT: 800,   // 最多外推天数

    getZzSignals() {
        const data = this.processedData;
        if (data.length < 110) return null;
        // 显示与外推锚点用「当前价」（优先实时价，回退 CSV 收盘），与概览卡口径一致
        const price = this.getCurrentPrice() ?? data[data.length - 1].close;
        const lastDate = data[data.length - 1].date;

        // 当前 MA 值 + 用于外推的窗口（最近 period 天收盘价）
        const cur = {}, windows = {};
        for (const p of this.ZZ_PERIODS) {
            const w = data.slice(-p).map(d => d.close);
            windows[p] = w.slice();
            cur[p] = w.reduce((a, b) => a + b, 0) / p;
        }

        // 逐日外推：未来第 t 天（t≥1）各 MA 值（假设价格恒为 price）
        const proj = { 6: [cur[6]], 103: [cur[103]], 110: [cur[110]] }; // index 0 = 今天
        const sim = {}, sums = {};
        for (const p of this.ZZ_PERIODS) { sim[p] = windows[p].slice(); sums[p] = cur[p] * p; }
        const maxT = this.ZZ_MAX_PROJECT;
        for (let t = 1; t <= maxT; t++) {
            for (const p of this.ZZ_PERIODS) {
                const removed = sim[p].shift();
                sim[p].push(price);
                sums[p] += price - removed;
                proj[p].push(sums[p] / p);
            }
        }

        // 求交叉天数：找第一处从下方「触及/上穿」的位置。
        // 用 diff>=0（含相等）而非严格 diff>0：价格恒定时，MA 会随旧值滚出而收敛到当前价，
        // 与价格只会「相切」而非严格穿越（如价格低于 MA110 的熊市行情）。若只认严格上穿，
        // 这类收敛就判不出交叉→掉进无日期的兜底句。改为「触及即算触发」，可稳定给出天数/日期，
        // 且日期随行情每日变化。
        const EPS = 1e-9;
        const findCross = (aArr, bArr, aStart, bStart) => {
            // aArr/bArr 为随 t 变化的数组（index=t）；aStart>bStart 表示已在上方
            let prevDiff = aStart - bStart;
            for (let t = 1; t < aArr.length; t++) {
                const diff = aArr[t] - bArr[t];
                if (prevDiff < -EPS && diff >= -EPS) return t; // 从下方触及/上穿
                prevDiff = diff;
            }
            return null;
        };
        // findCrossDown: a 从上方跌破 b（prevDiff > EPS → diff <= EPS）
        const findCrossDown = (aArr, bArr, aStart, bStart) => {
            let prevDiff = aStart - bStart;
            for (let t = 1; t < aArr.length; t++) {
                const diff = aArr[t] - bArr[t];
                if (prevDiff > EPS && diff <= EPS) return t; // 从上方触及/下穿
                prevDiff = diff;
            }
            return null;
        };
        // 价格恒定，价格数组就是常量 price
        const priceArr = new Array(proj[110].length).fill(price);
        // 牛市方向信号：上穿
        const crossPriceMA110 = findCross(priceArr, proj[110], price, cur[110]);
        const crossMA6MA103 = findCross(proj[6], proj[103], cur[6], cur[103]);
        // 熊市方向信号：下穿
        const crossPriceBelowMA110 = findCrossDown(priceArr, proj[110], price, cur[110]);
        const crossMA6BelowMA103 = findCrossDown(proj[6], proj[103], cur[6], cur[103]);

        // ── 回溯历史：找到信号实际触发的日期（最近一次上穿） ──
        // 上涨信号：price 从 MA110 下方穿到上方的那一天
        // 买入信号：MA6 从 MA103 下方穿到上方的那一天
        const ma110Full = this.calculateMA(data, 110);
        const ma6Full = this.calculateMA(data, 6);
        const ma103Full = this.calculateMA(data, 103);
        let triggeredUpDate = null, triggeredBuyDate = null;
        if (price > cur[110]) {
            // 从最后一天往前找 price <= MA110 的那天，次日即为触发日
            for (let i = data.length - 1; i >= 110; i--) {
                if (data[i].close <= ma110Full[i] && ma110Full[i] != null) {
                    triggeredUpDate = i + 1 < data.length ? data[i + 1].date : data[i].date;
                    break;
                }
            }
        }
        if (cur[6] > cur[103]) {
            // 从最后一天往前找 MA6 <= MA103 的那天
            for (let i = data.length - 1; i >= 103; i--) {
                if (ma6Full[i] != null && ma103Full[i] != null && ma6Full[i] <= ma103Full[i]) {
                    triggeredBuyDate = i + 1 < data.length ? data[i + 1].date : data[i].date;
                    break;
                }
            }
        }

        return {
            price, lastDate,
            cur,                       // {6,103,110}
            proj,                      // 未来外推序列（含今天为 index0）
            aboveMA110: price > cur[110],
            ma6AboveMA103: cur[6] > cur[103],
            // 信号实际触发的历史日期（null 表示追溯不到或未触发）
            triggeredUpDate,
            triggeredBuyDate,
            // 延长线交叉（假设价格不变）
            crossPriceMA110,           // 天数 or null
            crossMA6MA103,             // 天数 or null
            crossPriceMA110Date: crossPriceMA110 != null ? this.addDays(lastDate, crossPriceMA110) : null,
            crossMA6MA103Date: crossMA6MA103 != null ? this.addDays(lastDate, crossMA6MA103) : null,
            // 反向延长线交叉（假设价格不变）
            crossPriceBelowMA110,
            crossMA6BelowMA103,
            crossPriceBelowMA110Date: crossPriceBelowMA110 != null ? this.addDays(lastDate, crossPriceBelowMA110) : null,
            crossMA6BelowMA103Date: crossMA6BelowMA103 != null ? this.addDays(lastDate, crossMA6BelowMA103) : null,
        };
    },

    // 把日线聚合成周线（以周一为起点）
    aggregateWeekly(data) {
        const weeks = new Map();
        for (const d of data) {
            const dt = new Date(d.date);
            const day = dt.getDay();
            const diff = (day === 0 ? 6 : day - 1); // 周一为一周起点
            const weekStart = new Date(dt);
            weekStart.setDate(dt.getDate() - diff);
            const key = weekStart.toISOString().slice(0, 10);
            if (!weeks.has(key)) {
                weeks.set(key, { date: new Date(key), open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume });
            } else {
                const w = weeks.get(key);
                w.high = Math.max(w.high, d.high);
                w.low = Math.min(w.low, d.low);
                w.close = d.close;
                w.volume += d.volume;
            }
        }
        return Array.from(weeks.values()).sort((a, b) => a.date - b.date);
    },

    calculateRSI(data, period = 14) {
        const result = [];
        for (let i = 0; i < period; i++) result.push(null);

        let avgGain = 0, avgLoss = 0;
        for (let i = 1; i <= period; i++) {
            const change = data[i].close - data[i - 1].close;
            if (change > 0) avgGain += change;
            else avgLoss -= change;
        }
        avgGain /= period;
        avgLoss /= period;

        for (let i = period; i < data.length; i++) {
            if (i === period) {
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                result.push(100 - 100 / (1 + rs));
            } else {
                const change = data[i].close - data[i - 1].close;
                const gain = change > 0 ? change : 0;
                const loss = change < 0 ? -change : 0;
                avgGain = (avgGain * (period - 1) + gain) / period;
                avgLoss = (avgLoss * (period - 1) + loss) / period;
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                result.push(100 - 100 / (1 + rs));
            }
        }
        return result;
    },

    // 链上指标（MVRV/NUPL/已实现价格）经实测无法从浏览器直连免费 API
    // （CORS 拦截 + 严格限流），故在页面中改为嵌入官方图表（iframe）。
    // 这里保留基于 CSV 可稳定计算的市场结构指标供概览与周报使用。

    // Mayer Multiple = 价格 / MA200，历史上 >2.4 偏高(顶部风险)，<1 偏低(价值区)
    getMayerMultiple() {
        const data = this.processedData;
        if (data.length < 200) return null;
        const ma200arr = this.calculateMA(data.slice(-200), 200);
        const ma200 = ma200arr[ma200arr.length - 1];
        if (!ma200) return null;
        return data[data.length - 1].close / ma200;
    },

    // ===== 卖方衰竭指数 (Seller Exhaustion Index) =====
    // 公式: SEC = Supply_in_Profit_Proxy × 30d_Annualized_Volatility
    // Supply in Profit Proxy = 历史成交量中低于当前价格的占比（volume-weighted）
    // 当 SEC < 0.01 → 极端衰竭区（历史底部信号）
    _sellerExhaustion: null,

    getSellerExhaustion() {
        if (this._sellerExhaustion) return this._sellerExhaustion;
        const data = this.processedData;
        if (!data || data.length < 252) return null;

        const n = data.length;
        const closes = data.map(d => d.close);
        const volumes = data.map(d => d.volume || 0);

        // ─── 30-day Annualized Volatility ───
        const vol30 = new Array(n).fill(null);
        for (let i = 30; i < n; i++) {
            let sum = 0, sum2 = 0, cnt = 0;
            for (let j = i - 29; j <= i; j++) {
                if (closes[j - 1] > 0) {
                    const ret = Math.log(closes[j] / closes[j - 1]);
                    sum += ret; cnt++;
                }
            }
            if (cnt < 20) continue;
            const mean = sum / cnt;
            for (let j = i - 29; j <= i; j++) {
                if (closes[j - 1] > 0) {
                    const ret = Math.log(closes[j] / closes[j - 1]);
                    sum2 += (ret - mean) * (ret - mean);
                }
            }
            vol30[i] = Math.sqrt(sum2 / (cnt - 1)) * Math.sqrt(365);
        }

        // ─── Supply in Profit Proxy (4Y rolling percentile) ───
        // 当前价格在过去 4 年价格分布中的百分位（0-1）
        // 熊市底部时，当前价格位于 4Y 范围底部 → percentile 极低
        // 这是对 Glassnode "Supply in Profit %" 的最佳本地近似
        const WINDOW = 1460;  // 4 years
        const supplyProfit = new Array(n).fill(null);
        for (let i = 365; i < n; i++) {
            const winStart = Math.max(0, i - WINDOW);
            const curPrice = closes[i];
            let below = 0, total = 0;
            for (let j = winStart; j <= i; j++) {
                total++;
                if (closes[j] < curPrice) below++;
            }
            supplyProfit[i] = below / total;
        }

        // ─── Seller Exhaustion Index = supplyProfit × vol30 ───
        const result = [];
        for (let i = 0; i < n; i++) {
            if (vol30[i] == null || supplyProfit[i] == null) continue;
            const sec = supplyProfit[i] * vol30[i];
            result.push({
                date: data[i].date,
                price: closes[i],
                sec,
                supplyProfit: supplyProfit[i],
                vol30: vol30[i],
            });
        }

        this._sellerExhaustion = result;
        return result;
    },

    getSellerExhaustionCurrent() {
        const se = this.getSellerExhaustion();
        if (!se || !se.length) return null;
        return se[se.length - 1];
    },

    // ===== MVRV Pricing Bands（本地自绘，数据来自 CryptoQuant 导出的 CSV）=====
    // 模型（对齐 CheckOnChain MVRV Pricing Bands）：
    //   逐日用「从最早到当天」的累计(expanding) MVRV 均值 mean_i 与总体标准差 std_i，
    //   MVRV band_i = mean_i + k·std_i（随时间收敛的曲线，非固定直线）；
    //   价格 band_i = 已实现价格_i × (mean_i + k·std_i)。
    // 实测与 CheckOnChain 官方图逐点吻合（价格带 rel-MAE≈0.03%）。
    MVRV_BAND_DEFS: [
        { key: '+2.0sd', k: 2, color: '#ec4899' },
        { key: '+1.0sd', k: 1, color: '#f43f5e' },
        { key: '+0.5sd', k: 0.5, color: '#f59e0b' },
        { key: 'mean', k: 0, color: '#eab308' },
        { key: '-0.5sd', k: -0.5, color: '#3b82f6' },
        { key: '-1.0sd', k: -1, color: '#10b981' },
    ],

    // 返回 { defs, series }：series[i] = { mean, sd, coef:{key->值} } 对应 onchainData[i]。
    // coef 是当日 MVRV band 值；价格 band 由调用方乘以当日 realizedPrice。
    getMvrvBands() {
        if (this._mvrvBands) return this._mvrvBands;
        if (!this.onchainData.length) return null;
        const n = this.onchainData.length;
        const series = new Array(n);
        let sum = 0, sumSq = 0;
        for (let i = 0; i < n; i++) {
            const v = this.onchainData[i].mvrv;
            sum += v; sumSq += v * v;
            const cnt = i + 1;
            const mean = sum / cnt;
            const variance = Math.max(0, sumSq / cnt - mean * mean); // 总体方差
            const sd = Math.sqrt(variance);
            const coef = {};
            for (const def of this.MVRV_BAND_DEFS) coef[def.key] = mean + def.k * sd;
            series[i] = { mean, sd, coef };
        }
        this._mvrvBands = { defs: this.MVRV_BAND_DEFS, series };
        return this._mvrvBands;
    },

    // 最新 MVRV 值 + 落在哪个 band 区间（用当日的 band 系数判断）
    getMvrvCurrent() {
        if (!this.onchainData.length) return null;
        const bandInfo = this.getMvrvBands();
        if (!bandInfo) return null;
        const i = this.onchainData.length - 1;
        const latest = this.onchainData[i];
        const cur = bandInfo.series[i];              // 当日 band 系数
        const defs = bandInfo.defs;                  // 高→低
        const top = defs[0], bottom = defs[defs.length - 1];
        let zone = `低于 ${bottom.key}`;
        if (latest.mvrv >= cur.coef[top.key]) zone = `高于 ${top.key}`;
        else {
            for (let j = 0; j < defs.length - 1; j++) {
                if (latest.mvrv < cur.coef[defs[j].key] && latest.mvrv >= cur.coef[defs[j + 1].key]) {
                    zone = `${defs[j + 1].key} ~ ${defs[j].key} 之间`;
                    break;
                }
            }
        }
        return {
            date: latest.date, mvrv: latest.mvrv, realizedPrice: latest.realizedPrice, zone,
            mean: cur.mean, sd: cur.sd, coef: cur.coef,
            nupl: latest.nupl,
        };
    },

    // 当前 NUPL（最新一条）
    getNuplCurrent() {
        if (!this.onchainData.length) return null;
        for (let i = this.onchainData.length - 1; i >= 0; i--) {
            if (this.onchainData[i].nupl != null) {
                return { date: this.onchainData[i].date, nupl: this.onchainData[i].nupl };
            }
        }
        return null;
    },

    // ===== 4Y Rolling Realized Price Risk/Reward Ratio =====
    // 复刻 CryptoQuant 同名指标（已按官方 Excel 反推验证）：
    //   realized_price = price / mvrv
    //   over 过去 1462 天窗口取 mvrv 的经验分位数 p05 / p95
    //   bear_floor = realized_price × p05；bull_ceiling = realized_price × p95
    //   downside_risk = (price − bear_floor)/price；upside_reward = (bull_ceiling − price)/price
    //   R/R = upside_reward / downside_risk   （>1 上行空间占优/低估，<1 下行风险占优/高估）
    // 依赖 onchainData(mvrv) + processedData(price)。返回逐日序列（升序）。
    RR_WINDOW: 1462,
    _riskReward: null,

    getRiskReward() {
        if (this._riskReward) return this._riskReward;
        if (!this.onchainData.length) return null;
        const priceByDay = new Map();
        for (const d of this.processedData) priceByDay.set(d.date.toISOString().slice(0, 10), d.close);
        // 只需 MVRV(有值) + 价格：realized = price / mvrv（不依赖 realized_price.csv，
        // 因其起点晚，用它 join 会白白截短历史）。MVRV 自 2010-07 起有值，故 R/R 可回溯更早。
        const rows = [];
        for (const d of this.onchainData) {
            const key = d.date.toISOString().slice(0, 10);
            const price = priceByDay.get(key);
            if (price == null || !d.mvrv) continue;
            rows.push({ date: d.date, price, mvrv: d.mvrv, realized: price / d.mvrv });
        }
        // 经验分位（linear 插值，与 numpy 默认一致）
        const percentile = (sorted, p) => {
            const k = (sorted.length - 1) * p;
            const f = Math.floor(k), c = Math.ceil(k);
            if (f === c) return sorted[f];
            return sorted[f] * (c - k) + sorted[c] * (k - f);
        };
        const W = this.RR_WINDOW;
        const series = [];
        for (let i = 0; i < rows.length; i++) {
            if (i < W - 1) { series.push(null); continue; } // 窗口未满不算
            const seg = rows.slice(i - W + 1, i + 1).map(r => r.mvrv).sort((a, b) => a - b);
            const p05 = percentile(seg, 0.05), p95 = percentile(seg, 0.95);
            const r = rows[i];
            const bearFloor = r.realized * p05;
            const bullCeiling = r.realized * p95;
            const downRisk = (r.price - bearFloor) / r.price;
            const upReward = (bullCeiling - r.price) / r.price;
            const rr = downRisk !== 0 ? upReward / downRisk : null;
            series.push({ date: r.date, price: r.price, realized: r.realized, bearFloor, bullCeiling, downRisk, upReward, rr });
        }
        this._riskReward = rows.map((r, i) => ({ date: r.date, ...(series[i] || {}) }));
        return this._riskReward;
    },

    getRiskRewardCurrent() {
        const s = this.getRiskReward();
        if (!s) return null;
        for (let i = s.length - 1; i >= 0; i--) {
            if (s[i] && s[i].rr != null) return s[i];
        }
        return null;
    },

    // ===== 底部研判共享上下文 =====
    // 汇总「历史各轮周期底部」的链上特征（价格/已实现价格比、MVRV、NUPL），供多个指标分析复用，
    // 据此给出「若历史规律重演」的底部价位区间。历轮底部经数据核对：
    //   周期1底 2015-01 P/R≈0.57 MVRV≈0.56 NUPL≈-0.77
    //   周期2底 2018-12 P/R≈0.70 MVRV≈0.69 NUPL≈-0.45
    //   周期3底 2022-11 P/R≈0.78 MVRV≈0.78 NUPL≈-0.29
    // 规律：每轮底部「跌破已实现价格」的幅度逐轮收敛（0.57→0.70→0.78），MVRV/NUPL 底部同步抬升。
    HISTORICAL_BOTTOMS: [
        { label: '周期1 (2015底)', pr: 0.571, mvrv: 0.564, nupl: -0.774 },
        { label: '周期2 (2018底)', pr: 0.701, mvrv: 0.691, nupl: -0.447 },
        { label: '周期3 (2022底)', pr: 0.779, mvrv: 0.778, nupl: -0.285 },
    ],

    getBottomContext() {
        const latest = this.getLatest();
        const mvrvCur = this.getMvrvCurrent();
        if (!latest || !mvrvCur) return null;
        const price = latest.close;
        const realized = mvrvCur.realizedPrice;
        const b = this.HISTORICAL_BOTTOMS;
        const prMin = Math.min(...b.map(x => x.pr));   // 最深（0.571）
        const prMax = Math.max(...b.map(x => x.pr));   // 最浅（0.779）
        // 底部价位区间：已实现价格 × 历轮 P/R（下限用最深、上限用最浅）
        const bottomLow = realized * prMin;
        const bottomHigh = realized * prMax;
        return {
            price, realized,
            priceToRealized: price / realized,
            mvrv: mvrvCur.mvrv,
            nupl: mvrvCur.nupl,
            bottoms: b,
            prMin, prMax,
            bottomLow, bottomHigh,
            aboveRealized: price > realized,
        };
    },

    getWeekdayStats() {
        // 短周期规律仅分析近 3 个月（约 90 天）——比全历史更贴近当下节奏
        const recent = this.processedData.slice(-91);
        const stats = Array.from({ length: 7 }, () => ({ up: 0, down: 0, total: 0, sumRet: 0 }));
        for (let i = 1; i < recent.length; i++) {
            const d = recent[i];
            const prev = recent[i - 1];
            const day = d.date.getDay();
            const ret = (d.close - prev.close) / prev.close;
            stats[day].total++;
            stats[day].sumRet += ret;
            if (d.close > prev.close) stats[day].up++;
            else stats[day].down++;
        }
        for (const s of stats) {
            s.upRate = s.total ? s.up / s.total : 0;
            s.avgRet = s.total ? s.sumRet / s.total : 0;
        }
        return stats;
    },

    // 分析短周期规律：找出上涨概率最高/最低的星期，生成可读结论
    getWeekdayPattern() {
        const stats = this.getWeekdayStats();
        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        let best = 0, worst = 0;
        for (let i = 1; i < 7; i++) {
            if (stats[i].upRate > stats[best].upRate) best = i;
            if (stats[i].upRate < stats[worst].upRate) worst = i;
        }
        // 语义：某星期上涨概率≥50% 描述为「上涨概率」，否则描述为「下跌概率」(=1-上涨概率)
        const fmtDay = (i) => {
            const up = stats[i].upRate;
            const ret = stats[i].avgRet;
            if (up >= 0.5) return `${dayNames[i]}偏涨（上涨概率 ${(up * 100).toFixed(1)}%，平均 ${(ret * 100).toFixed(2)}%）`;
            return `${dayNames[i]}偏跌（下跌概率 ${((1 - up) * 100).toFixed(1)}%，平均 ${(ret * 100).toFixed(2)}%）`;
        };
        return {
            stats,
            dayNames,
            bestDay: best,
            worstDay: worst,
            bestRate: stats[best].upRate,
            worstRate: stats[worst].upRate,
            bestAvgRet: stats[best].avgRet,
            worstAvgRet: stats[worst].avgRet,
            summary: `近 3 个月数据显示：最强 ${fmtDay(best)}；最弱 ${fmtDay(worst)}。`
        };
    },

    // 四年周期叠加对比图：每条曲线从该轮周期的最高点(day 0, 归一化=1)开始绘制，
    // 展示见顶后的回撤与恢复过程。横轴为"距该轮最高点的天数"，纵轴为相对最高点的倍数（对数）。
    getCycleData() {
        // 各减半周期区间，用于在区间内定位历史最高点
        const cycleRanges = [
            { start: '2011-01-01', end: '2015-01-01', label: '周期1 (2013顶)' },
            { start: '2015-01-01', end: '2019-01-01', label: '周期2 (2017顶)' },
            { start: '2019-01-01', end: '2023-01-01', label: '周期3 (2021顶)' },
            { start: '2023-01-01', end: '2027-01-01', label: '周期4 (当前)' },
        ];
        const cycles = [];
        for (const r of cycleRanges) {
            const start = new Date(r.start);
            const end = new Date(r.end);
            const inRange = this.processedData.filter(d => d.date >= start && d.date < end);
            if (inRange.length === 0) continue;

            // 找该区间内最高收盘价的位置作为起点
            let peakIdx = 0;
            for (let i = 1; i < inRange.length; i++) {
                if (inRange[i].close > inRange[peakIdx].close) peakIdx = i;
            }
            const peakDate = inRange[peakIdx].date;
            const peakPrice = inRange[peakIdx].close;

            // 从最高点开始，向后取全部数据（跨到下一区间也继续，直到数据结束或到达约1600天）
            const fromPeak = this.processedData.filter(d => d.date >= peakDate);
            const maxDays = 1600;
            cycles.push({
                label: r.label,
                data: fromPeak
                    .map(d => ({
                        day: Math.floor((d.date - peakDate) / (1000 * 60 * 60 * 24)),
                        normalized: d.close / peakPrice
                    }))
                    .filter(p => p.day <= maxDays)
            });
        }
        return cycles;
    },

    // 四年大周期定位：基于日历年（3涨1跌模型），语气结合价格与均线趋势
    getCyclePhase() {
        const latest = this.getLatest();
        const now = latest ? latest.date : new Date();
        const year = now.getFullYear();
        const phaseInfo = CYCLE_YEAR_PHASES[year % 4];

        // 计算年内进度
        const yearStart = new Date(`${year}-01-01`);
        const yearEnd = new Date(`${year + 1}-01-01`);
        const yearProgress = (now - yearStart) / (yearEnd - yearStart);

        // 结合价格趋势判断（是否站上 MA200）以调整语气
        const trend = this.getTrendState();

        // 整体四年进度：以最近一次减半年为起点
        const cycleAnchorYear = year - (year % 4); // 减半年
        const cycleStart = new Date(`${cycleAnchorYear}-01-01`);
        const cycleEnd = new Date(`${cycleAnchorYear + 4}-01-01`);
        const cycleProgress = (now - cycleStart) / (cycleEnd - cycleStart);

        let tone = phaseInfo.desc;
        if (phaseInfo.key === 'bear' && trend.aboveMA200) {
            tone = '按日历年模型属回调年，但当前价格仍在 MA200 上方，趋势尚未完全转弱';
        } else if ((phaseInfo.key === '1st-bull' || phaseInfo.key === '2nd-bull') && !trend.aboveMA200) {
            tone = phaseInfo.desc + '；但当前价格已跌破 MA200，需警惕趋势背离';
        }

        return {
            year,
            phase: phaseInfo.name,
            phaseKey: phaseInfo.key,
            phaseColor: phaseInfo.color,
            detail: tone,
            yearProgress: Math.min(Math.max(yearProgress, 0), 1),
            progress: Math.min(Math.max(cycleProgress, 0), 1),
            cycleAnchorYear,
        };
    },

    getTrendState() {
        const data = this.processedData;
        if (data.length < 200) return { aboveMA200: false, aboveMA50: false, ma50: null, ma200: null };
        const ma50arr = this.calculateMA(data.slice(-50), 50);
        const ma200arr = this.calculateMA(data.slice(-200), 200);
        const ma50 = ma50arr[ma50arr.length - 1];
        const ma200 = ma200arr[ma200arr.length - 1];
        const price = data[data.length - 1].close;
        return { aboveMA200: price > ma200, aboveMA50: price > ma50, ma50, ma200, price };
    },

    // 工具：把 Date 加 n 天并格式化为 "YYYY年M月D日"
    fmtDate(date) {
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    },
    addDays(date, n) {
        const d = new Date(date);
        d.setDate(d.getDate() + n);
        return d;
    },

    // ===== 周报前瞻分析引擎：每个指标产出 {title, position, outlook} =====

    // 四年周期：当前距高点天数/跌幅，对比历史 → 推算本轮最低点日期与价格区间
    analyzeCycle() {
        const cycles = this.getCycleData();
        if (cycles.length < 2) return null;
        const latest = this.getLatest();

        // 前 3 轮（已完成）的最低点：天数 + 跌幅
        const past = cycles.slice(0, 3).map(c => {
            let low = c.data[0];
            for (const p of c.data) if (p.normalized < low.normalized) low = p;
            return { day: low.day, drawdown: (1 - low.normalized) * 100 };
        });
        const cur = cycles[cycles.length - 1];
        let curLow = cur.data[0];
        for (const p of cur.data) if (p.normalized < curLow.normalized) curLow = p;
        const curDay = cur.data[cur.data.length - 1].day; // 距高点已过天数
        const curDrawdown = (1 - curLow.normalized) * 100;

        // 本轮高点日期与价格
        const peakDate = this.addDays(latest.date, -curDay);
        // 峰值价：curLow.normalized 是相对峰值，反推峰值
        const peakPrice = curLow.normalized > 0 ? (latest.close / (cur.data[cur.data.length - 1].normalized)) : null;

        const dayMin = Math.min(...past.map(p => p.day));
        const dayMax = Math.max(...past.map(p => p.day));
        const ddMin = Math.min(...past.map(p => p.drawdown));
        const ddMax = Math.max(...past.map(p => p.drawdown));

        const lowDateStart = this.fmtDate(this.addDays(peakDate, dayMin));
        const lowDateEnd = this.fmtDate(this.addDays(peakDate, dayMax));
        const priceLow = peakPrice * (1 - ddMax / 100);
        const priceHigh = peakPrice * (1 - ddMin / 100);

        const ddList = past.map(p => p.drawdown.toFixed(0) + '%').join(' / ');
        let text = `当前距本轮高点已下跌 ${curDay} 天，期间最大跌幅 ${curDrawdown.toFixed(1)}%。此前 3 轮周期见底耗时 ${dayMin}–${dayMax} 天，分别为 ${ddList}，跌幅逐轮收敛。`;
        if (curDay >= dayMax) {
            text += `本轮下跌天数已超过历史区间上限（${dayMax} 天），若历史规律仍成立，周期底部大概率已在近期出现或临近，可重点关注筑底信号。`;
        } else {
            text += `若按历史见底耗时推演，本轮低点可能落在 ${lowDateStart} 至 ${lowDateEnd}，按跌幅法约 $${Math.round(priceLow).toLocaleString()}–$${Math.round(priceHigh).toLocaleString()}。`;
        }
        return { key: 'cycle', title: '四年大周期对比（从各轮最高点对齐）', text };
    },

    // zZ 指标分析：价格 vs MA110（上涨/牛市信号）、MA6 vs MA103 金叉（买入信号）。
    // 增加反向信号：价格下穿 MA110（转熊）、MA6 下穿 MA103（卖出/死叉）。
    // 所有延长线交叉日期均为「假设价格维持当前不变」的动态推算，不是固定预测——
    // 价格每天变化，这些日期也会跟着移动。
    analyzeMA() {
        const zz = this.getZzSignals();
        if (!zz) return null;
        const price = zz.price;
        let text = `当前价 $${Math.round(price).toLocaleString()}，`;

        // 组A：上涨/转牛信号（价格上穿 MA110）+ 转熊预警（价格下穿 MA110）
        if (zz.aboveMA110) {
            text += `上涨信号持续中（价格 > MA110 $${Math.round(zz.cur[110]).toLocaleString()}`;
            if (zz.triggeredUpDate) text += `，${this.fmtDate(zz.triggeredUpDate)} 触发`;
            text += `）。`;
            if (zz.crossPriceBelowMA110 != null) {
                text += `延长线推算：若价格维持不变，约 ${zz.crossPriceBelowMA110} 天后（${this.fmtDate(zz.crossPriceBelowMA110Date)}）价格将下穿 MA110——但该日期并非固定预测，价格每天变化都会使它前移或后推。`;
            }
        } else if (zz.crossPriceMA110 != null) {
            text += `尚未触发上涨信号（价格 < MA110 $${Math.round(zz.cur[110]).toLocaleString()}）。延长线推算：若价格维持不变，约 ${zz.crossPriceMA110} 天后（${this.fmtDate(zz.crossPriceMA110Date)}）MA110 将下行至当前价位附近。`;
        } else {
            text += `尚未触发上涨信号，按当前价格外推 ${this.ZZ_MAX_PROJECT} 天内价格仍不会上穿 MA110。`;
        }

        // 组B：买入信号（MA6 上穿 MA103 金叉）+ 卖出预警（MA6 下穿 MA103 死叉）
        if (zz.ma6AboveMA103) {
            text += ` 买入信号持续中（MA6 > MA103`;
            if (zz.triggeredBuyDate) text += `，${this.fmtDate(zz.triggeredBuyDate)} 触发`;
            text += `）。`;
            if (zz.crossMA6BelowMA103 != null) {
                text += `延长线推算：若价格维持不变，约 ${zz.crossMA6BelowMA103} 天后（${this.fmtDate(zz.crossMA6BelowMA103Date)}）MA6 将死叉 MA103——同理，该日期会随价格波动而变化。`;
            }
        } else if (zz.crossMA6MA103 != null) {
            text += ` 尚未触发买入信号（MA6 < MA103）。延长线推算：若价格维持不变，约 ${zz.crossMA6MA103} 天后（${this.fmtDate(zz.crossMA6MA103Date)}）MA6 将上穿 MA103。`;
        } else {
            text += ` 按当前价格外推 ${this.ZZ_MAX_PROJECT} 天内 MA6 仍不会上穿 MA103，买入信号尚未临近。`;
        }
        return { key: 'ma', title: 'zZ 指标', text };
    },

    // Mayer Multiple 分析
    analyzeMayer() {
        const m = this.getMayerMultiple();
        if (m == null) return null;
        const data = this.processedData;
        const price = data[data.length - 1].close;
        const ma200arr = this.calculateMA(data.slice(-200), 200);
        const ma200 = ma200arr[ma200arr.length - 1];

        // 历史周期底部 Mayer 多在 0.5–0.7；据此推底部价位 = MA200 × [0.5, 0.7]
        const bLo = ma200 * 0.5, bHi = ma200 * 0.7;
        const head = `当前 Mayer Multiple = ${m.toFixed(2)}（价格 $${Math.round(price).toLocaleString()} / MA200 $${Math.round(ma200).toLocaleString()}）。历史上 >2.4 为过热顶部区，<1 为价值区，周期底部多落在 0.5–0.7。`;
        let tail;
        if (m > 2.4) tail = `已进入历史过热区间，向上空间受限，需警惕均值回归带来的回调压力。`;
        else if (m < 1) tail = `价格位于 MA200 下方，已进入历史价值区。若按周期底部 Mayer 0.5–0.7 测算，买入价位区间约 $${Math.round(bLo).toLocaleString()}–$${Math.round(bHi).toLocaleString()}。`;
        else tail = `处于 1–2.4 的中性区间，方向性不强，跟随大周期与均线趋势运行。若后续转弱回到价值区，按 Mayer 0.5–0.7 对应买入价位区间约 $${Math.round(bLo).toLocaleString()}–$${Math.round(bHi).toLocaleString()}。`;
        return { key: 'mayer', title: 'Mayer Multiple（价格/MA200）', text: head + tail };
    },

    // MVRV 分析（本地自绘 Pricing Bands）：当前 MVRV 值、所处 band 区间、离顶/底 band 的距离
    // 用当日 expanding 均值/标准差推得的 band（getMvrvCurrent 已返回当日 coef）。
    analyzeMvrv() {
        const cur = this.getMvrvCurrent();
        if (!cur) return null;
        const topCoef = cur.coef['+2.0sd'];
        const bottomCoef = cur.coef['-1.0sd'];
        const impliedPrice = cur.mvrv * cur.realizedPrice;
        const topPrice = topCoef * cur.realizedPrice;
        const bottomPrice = bottomCoef * cur.realizedPrice;

        // 历史周期底部 MVRV：0.56 / 0.69 / 0.78（逐轮抬升）。据此推底部价位 = 已实现价 × [0.56, 0.78]
        const bt = this.HISTORICAL_BOTTOMS;
        const mvLo = Math.min(...bt.map(x => x.mvrv)), mvHi = Math.max(...bt.map(x => x.mvrv));
        const btPriceLo = mvLo * cur.realizedPrice, btPriceHi = mvHi * cur.realizedPrice;
        const head = `当前 MVRV = ${cur.mvrv.toFixed(2)}，历史周期底部 MVRV 约 ${mvLo.toFixed(2)}–${mvHi.toFixed(2)}。`;
        let tail;
        if (cur.mvrv >= topCoef) tail = `MVRV 已触及 +2.0sd 过热带，历史上对应周期顶部风险，链上浮盈丰厚、抛压易积累。`;
        else if (cur.mvrv <= mvHi) tail = `MVRV=${cur.mvrv.toFixed(2)} 已进入历史底部区间，全市场平均接近或处于亏损，是周期价值区，但磨底可能持续。`;
        else tail = `MVRV=${cur.mvrv.toFixed(2)} 高于历史底部区。若历史规律重演，周期底部 MVRV 落在 ${mvLo.toFixed(2)}–${mvHi.toFixed(2)}，对应价位区间约 $${Math.round(btPriceLo).toLocaleString()}–$${Math.round(btPriceHi).toLocaleString()}。`;
        return { key: 'mvrv', title: 'MVRV 估值带', text: head + tail };
    },

    // 已实现价格分析（链上全市场持币成本）：历轮周期底部 BTC 价格均跌破已实现价格，据此研判底部
    analyzeRealizedPrice() {
        const ctx = this.getBottomContext();
        if (!ctx) return null;
        const bt = ctx.bottoms;
        const ratios = bt.map(x => x.pr.toFixed(2)).join(' / ');
        let text = `当前 BTC 价格 $${Math.round(ctx.price).toLocaleString()}，已实现价格 $${Math.round(ctx.realized).toLocaleString()}，价格/已实现价格 = ${ctx.priceToRealized.toFixed(2)}。此前 3 轮周期底部，BTC 价格均跌破已实现价格，价格/已实现价格分别为 ${ratios}。`;
        if (ctx.aboveRealized) {
            text += `若重演该规律，约 $${Math.round(ctx.bottomLow).toLocaleString()}–$${Math.round(ctx.bottomHigh).toLocaleString()}。`;
        } else {
            text += `当前比值 ${ctx.priceToRealized.toFixed(2)} 已跌破成本线、进入历史底部特征区；若向 ${ctx.prMin} 靠拢，对应价位约 $${Math.round(ctx.bottomLow).toLocaleString()}。`;
        }
        return { key: 'realized', title: '已实现价格 / 全市场持币成本', text };
    },

    // NUPL 分析（净未实现盈亏）：分区 + 历史底部 NUPL 转负特征
    analyzeNupl() {
        const cur = this.getNuplCurrent();
        if (!cur) return null;
        const nupl = cur.nupl;
        const bt = this.HISTORICAL_BOTTOMS;
        const nuplBottoms = bt.map(x => x.nupl);
        // NUPL 分区（CheckOnChain 口径）
        let zoneLabel;
        if (nupl >= 0.75) zoneLabel = '欣快（>0.75，顶部风险区）';
        else if (nupl >= 0.5) zoneLabel = '贪婪（0.5–0.75）';
        else if (nupl >= 0.25) zoneLabel = '乐观/焦虑（0.25–0.5）';
        else if (nupl >= 0) zoneLabel = '希望/恐惧（0–0.25）';
        else zoneLabel = '投降（<0，市场整体亏损）';
        const nLo = Math.min(...nuplBottoms).toFixed(2), nHi = Math.max(...nuplBottoms).toFixed(2);
        const head = `当前 NUPL = ${nupl.toFixed(3)}。历史周期底部 NUPL 约 ${nLo}–${nHi}。`;
        let tail;
        if (nupl < 0) tail = `NUPL 已转负、市场整体亏损——这是历史周期底部的典型特征，当前已进入投降区，属历史价值区间，但仍需结合价格与已实现价格确认筑底。`;
        else if (nupl >= 0.75) tail = `NUPL 进入欣快区（>0.75），历史上对应周期顶部，浮盈过高、获利抛压风险大。`;
        else tail = `NUPL=${nupl.toFixed(3)} 尚未转负，距历史底部 NUPL 转负仍有距离。`;
        return { key: 'nupl', title: 'NUPL 净未实现盈亏', text: head + tail };
    },

    // RSI 分析（日线 + 周线）
    analyzeRSI() {
        const data = this.processedData;
        const dRsiArr = this.calculateRSI(data.slice(-60));
        const dRsi = dRsiArr[dRsiArr.length - 1];
        const weekly = this.aggregateWeekly(data);
        const wRsiArr = this.calculateRSI(weekly.slice(-60));
        const wRsi = wRsiArr[wRsiArr.length - 1];

        const head = `周线 RSI-14 = ${wRsi ? wRsi.toFixed(1) : 'N/A'}。`;
        let tail;
        if (wRsi < 30) tail = `周线 RSI 已进入超卖区（<30），历史上常对应周期性底部；若同时出现「价格创新低而 RSI 不创新低」的正向背离，是较强的反转信号，可与周期/MVRV/已实现价格的价位区间交叉验证。`;
        else if (wRsi > 70) tail = `周线 RSI 超买（>70），中期过热，上行动能可能衰减，注意高位波动放大。`;
        else tail = `上一轮周期中，周线 RSI 先于 BTC 价格见底。如参照上一轮行情，或许还有最后一跌。但该跌并不会在周线 RSI 上显示出极值。`;
        return { key: 'rsi', title: 'RSI 强弱指标', text: head + tail };
    },

    // 4Y Rolling Realized Price Risk/Reward Ratio 分析
    analyzeRiskReward() {
        const cur = this.getRiskRewardCurrent();
        if (!cur) return null;
        const rr = cur.rr;
        const head = `当前 4Y R/R 比 = ${rr.toFixed(2)}。该比 = 上行空间/下行风险，>1 表示上行空间占优，<1 表示下行风险占优。`;
        let tail;
        if (rr >= 3) tail = `R/R ≥ 3，上行空间显著大于下行风险，处于历史低估区，是周期底部附近常见的风险回报结构。下行底线约 $${Math.round(cur.bearFloor).toLocaleString()}。`;
        else if (rr <= 0.3) tail = `R/R ≤ 0.3，下行风险显著大于上行空间，处于历史高估区，周期顶部风险区常见。上行天花板约 $${Math.round(cur.bullCeiling).toLocaleString()}。`;
        else tail = `R/R=${rr.toFixed(2)} 处于中性区间。下行底线约 $${Math.round(cur.bearFloor).toLocaleString()}、上行天花板约 $${Math.round(cur.bullCeiling).toLocaleString()}；比值向 1 以下走表示风险积累、向 3 以上走表示价值显现。`;
        return { key: 'riskreward', title: '4Y 已实现价格风险回报比', text: head + tail };
    },

    // Cointime Price（时间加权持币成本，本地无该数据，做定性思路描述，图见嵌入的 CheckOnChain）
    analyzeCointime() {
        const ctx = this.getBottomContext();
        const anchor = ctx ? `（当前已实现价格 $${Math.round(ctx.realized).toLocaleString()} 可作近似参照）` : '';
        const text = `Cointime Price 是按币龄时间加权的全市场持币成本线，比已实现价格更强调长期持有者成本${anchor}。历史上每轮周期最低点都曾跌破 Cointime Price / 已实现价格；若价格横盘而成本线随时间上移并最终交叉，往往意味着市场进入亏损主导、逼近周期底部区域。具体价位请参照「已实现价格」与「MVRV」给出的底部区间。`;
        return { key: 'cointime', title: 'Cointime Price / 时间加权成本线', text };
    },

    // ETF 累计净流入的「斜率」序列：累计线的上升速度（= 单位时间进场的增量资金）。
    // 用滚动窗口最小二乘拟合斜率，平滑日噪声。斜率>0 资金净流入（累计线上行）、越陡流入越猛；
    // 斜率<0 资金净流出。窗口越短越灵敏、越长越平滑。单位：百万美元/天。
    //   返回 [{date, price, slope7, slope30}]（升序，price 取当日 BTC 收盘，缺失为 null）。
    getEtfSlopeSeries() {
        const d = this.etfData;
        if (!d || !d.length) return null;
        const priceByDay = new Map();
        for (const p of this.processedData) priceByDay.set(p.date.toISOString().slice(0, 10), p.close);
        // 对窗口内的累计值做 y=a+b·t 最小二乘，返回斜率 b（t=0..n-1，单位=天）
        const slopeAt = (i, win) => {
            const start = i - win + 1;
            if (start < 0) return null;
            const n = win;
            let sx = 0, sy = 0, sxy = 0, sxx = 0;
            for (let k = 0; k < n; k++) {
                const t = k, y = d[start + k].cumulative;
                sx += t; sy += y; sxy += t * y; sxx += t * t;
            }
            const denom = n * sxx - sx * sx;
            if (denom === 0) return null;
            return (n * sxy - sx * sy) / denom;
        };
        return d.map((x, i) => ({
            date: x.date,
            price: priceByDay.get(x.date.toISOString().slice(0, 10)) ?? null,
            slope7: slopeAt(i, 7),
            slope30: slopeAt(i, 30),
        }));
    },

    // ETF 累计净流入斜率分析（周报用）：斜率 = 增量资金进场速度，斜率转向常领先价格。
    analyzeEtfSlope() {
        const series = this.getEtfSlopeSeries();
        if (!series || !series.length) return null;
        const last = series[series.length - 1];
        if (last.slope30 == null) return null;
        const fmt = v => (v >= 0 ? '+' : '') + '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'B' : v.toFixed(0) + 'M') + '/日';
        // 找最近一次 30 日斜率穿越 0 的日期（资金环境切换点）
        let flipDate = null, flipDir = null;
        for (let i = series.length - 1; i > 0; i--) {
            const a = series[i - 1].slope30, b = series[i].slope30;
            if (a == null || b == null) continue;
            if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) { flipDate = series[i].date; flipDir = b >= 0 ? '转正（流入）' : '转负（流出）'; break; }
        }
        let text = `ETF 累计净流入的「斜率」衡量增量资金的进场速度：斜率为正=资金持续净流入（累计线上行），越陡流入越猛；斜率为负=资金净流出。`;
        text += `当前 30 日斜率 ${fmt(last.slope30)}${last.slope7 != null ? `、7 日斜率 ${fmt(last.slope7)}` : ''}（${this.fmtDate(last.date)}）——${last.slope30 >= 0 ? '中期资金仍在净流入，为价格提供增量支撑' : '中期资金转为净流出，增量推力减弱'}${last.slope7 != null && last.slope30 != null ? (last.slope7 > last.slope30 ? '，且短期流入在加速' : last.slope7 < last.slope30 ? '，短期流入较中期已放缓' : '') : ''}。`;
        if (flipDate) text += `最近一次 30 日斜率${flipDir}发生在 ${this.fmtDate(flipDate)}。`;
        text += `斜率的方向转换往往与价格拐点同步或略微领先，可与价格叠加观察资金与走势的共振。`;
        return { key: 'etfslope', title: 'ETF 累计净流入斜率（资金进场速度）', text };
    },

    // ETF 资金流分析：现货 ETF 净流量是当前最可量化的「增量资金」，与 BTC 走势强相关。
    analyzeEtf() {
        const d = this.etfData;
        if (!d || !d.length) return null;
        const latest = d[d.length - 1];
        const last5 = d.slice(-5);
        const last20 = d.slice(-20);
        const sum = arr => arr.reduce((a, b) => a + b.flow, 0);
        const s5 = sum(last5), s20 = sum(last20);
        const cum = latest.cumulative;
        // 与 BTC 价格的相关性：用累计净流入 vs 价格（同期）算皮尔逊相关
        const priceByDay = new Map();
        for (const p of this.processedData) priceByDay.set(p.date.toISOString().slice(0, 10), p.close);
        const pairs = d.map(x => [x.cumulative, priceByDay.get(x.date.toISOString().slice(0, 10))]).filter(p => p[1] != null);
        let corr = null;
        if (pairs.length > 30) {
            const n = pairs.length;
            const mx = pairs.reduce((a, p) => a + p[0], 0) / n;
            const my = pairs.reduce((a, p) => a + p[1], 0) / n;
            let sxy = 0, sxx = 0, syy = 0;
            for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
            corr = sxy / Math.sqrt(sxx * syy);
        }
        const fmt = v => (v >= 0 ? '+' : '') + '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'B' : v.toFixed(0) + 'M');
        let text = `美国现货 BTC ETF 最新一日净${latest.flow >= 0 ? '流入' : '流出'} ${fmt(latest.flow)}（${this.fmtDate(latest.date)}）。近 5 日累计 ${fmt(s5)}、近 20 日累计 ${fmt(s20)}；ETF 上市以来累计净流入 ${fmt(cum)}。`;
        if (corr != null) text += `累计净流入与 BTC 价格相关系数 ${corr.toFixed(2)}${corr > 0.7 ? '（强正相关，资金流入是本轮上涨的重要推力）' : corr > 0.4 ? '（中度正相关）' : ''}。`;
        text += `${s20 > 0 ? '近 20 日净流入为正，增量资金仍在进场，对价格形成支撑' : '近 20 日净流出，增量资金撤离，需警惕price承压'}。`;
        text += `（口径：Glassnode 等采用此法——先算各 ETF 持仓 BTC 数量的日变化，再按纽约时间 16:00 左右的 BTC 收盘价折算为美元净流量。）`;
        return { key: 'etf', title: 'ETF 资金流（增量资金）', text };
    },

    // BTC/AAPL 比率分析：衡量 BTC 相对美股龙头的相对强弱，周期性明显
    analyzeBtcAapl() {
        const d = this.btcAaplData;
        if (!d || d.length < 30) return null;
        const latest = d[d.length - 1];
        // 找历史最高比率和最低比率
        let peak = d[0], trough = d[0];
        for (const r of d) {
            if (r.ratio > peak.ratio) peak = r;
            if (r.ratio < trough.ratio) trough = r;
        }
        // 近 30 日变化
        const d30ago = d[Math.max(0, d.length - 31)];
        const change30 = ((latest.ratio - d30ago.ratio) / d30ago.ratio * 100).toFixed(1);
        // 距峰值的回撤
        const drawdown = ((1 - latest.ratio / peak.ratio) * 100).toFixed(1);
        let text = `当前 BTC/AAPL 比率 = ${latest.ratio.toFixed(1)}（${this.fmtDate(latest.date)}），`;
        text += `即 1 个 BTC 可换约 ${Math.round(latest.ratio)} 股 AAPL。`;
        text += `历史最高 ${peak.ratio.toFixed(1)}（${this.fmtDate(peak.date)}），距峰值回撤 ${drawdown}%。`;
        text += `近 30 日变化 ${change30}%。`;
        if (latest.ratio > peak.ratio * 0.8) {
            text += `比率处于历史高位区间，BTC 相对 AAPL 表现强势。`;
        } else if (latest.ratio < peak.ratio * 0.3) {
            text += `比率处于历史低位，BTC 相对 AAPL 表现较弱，可能是底部区域。`;
        } else {
            text += `比率处于中间区间，关注趋势方向。`;
        }
        text += `该指标呈现明显的 4 年周期性，每轮牛市 BTC/AAPL 比率均创新高，熊市回落形成长期上升通道。`;
        return { key: 'btcaapl', title: 'BTC/AAPL 比率（相对强弱）', text };
    },

    // BTC/AAPL 当前值（供页面显示）
    getBtcAaplCurrent() {
        const d = this.btcAaplData;
        if (!d || !d.length) return null;
        return d[d.length - 1];
    },

    // 汇总所有分析。顺序：SMM复合 → 大周期 → 均线 → 估值(Mayer/MVRV) → 链上成本(已实现价格) → 情绪(NUPL/RSI) → 资金(ETF) → BTC/AAPL → Cointime
    getReportAnalysis() {
        return [
            typeof SmmModule !== 'undefined' ? SmmModule.analyzeSmm() : null,
            this.analyzeCycle(),
            this.analyzeCycleTrough ? this.analyzeCycleTrough() : null,
            this.analyzeCycleHalving ? this.analyzeCycleHalving() : null,
            this.analyzeCycleStrength ? this.analyzeCycleStrength() : null,
            this.analyzeMA(),
            this.analyzeMayer(),
            this.analyzeMvrv(),
            this.analyzeMvrvCycle ? this.analyzeMvrvCycle() : null,
            this.analyzeRealizedPrice(),
            this.analyzeNupl(),
            this.analyzeRiskReward(),
            this.analyzeRSI(),
            this.analyzeEtf(),
            this.analyzeEtfSlope(),
            this.analyzeBtcAapl(),
            this.analyzeCointime(),
        ].filter(Boolean);
    },

    async fetchStablecoinSupply() {
        try {
            const resp = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=false');
            const json = await resp.json();
            const list = json.peggedAssets || [];
            let total = 0, usdt = 0;
            for (const a of list) {
                const cur = a.circulating && (a.circulating.peggedUSD || 0);
                if (!cur) continue;
                total += cur;
                if (a.symbol === 'USDT') usdt = cur;
            }
            return { total, usdt };
        } catch (e) {
            console.warn('Stablecoin fetch failed:', e.message);
            return null;
        }
    },

    async fetchLivePrice() {
        try {
            const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_market_cap=true');
            const data = await resp.json();
            return {
                price: data.bitcoin.usd,
                change24h: data.bitcoin.usd_24h_change,
                marketCap: data.bitcoin.usd_market_cap
            };
        } catch (e) {
            console.warn('Live price fetch failed, using CSV data');
            const latest = this.getLatest();
            if (!latest) return null;
            const prev = this.processedData[this.processedData.length - 2];
            return {
                price: latest.close,
                change24h: prev ? ((latest.close - prev.close) / prev.close) * 100 : 0,
                marketCap: latest.marketCap
            };
        }
    }
};
