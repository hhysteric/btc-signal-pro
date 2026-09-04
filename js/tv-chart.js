/**
 * TvChartModule — TradingView Lightweight Charts 交互式 K 线面板
 *
 * 所有指标均叠加在主图上（无副图），不同量纲的指标用独立 priceScale 显示
 * 支持日线/周线切换、对数/线性坐标、鼠标悬浮 OHLC + 涨幅 Legend
 *
 * 依赖：LightweightCharts (全局), DataModule, SmmModule
 */
const TvChartModule = {
    chart: null,
    candleSeries: null,
    indicators: {},         // { key: { series, scaleId } }
    activeIndicators: new Set(),
    _invertedScales: new Set(), // 已翻转的 scaleId
    _container: null,
    _timeframe: 'daily',   // 'daily' | 'weekly'
    _logScale: false,

    // ─── 指标定义 ───────────────────────────────────────────────
    INDICATORS: {
        // 主图同轴（价格量纲）
        ma6:       { label: 'MA6',       color: '#3b82f6', type: 'line', scaleId: 'right' },
        ema50:     { label: 'EMA50',     color: '#10b981', type: 'line', scaleId: 'right' },
        ema110:    { label: 'EMA110',    color: '#e879f9', type: 'line', scaleId: 'right' },
        ma103:     { label: 'MA103',     color: '#ef4444', type: 'line', scaleId: 'right' },
        ma110:     { label: 'MA110',     color: '#a855f7', type: 'line', scaleId: 'right' },
        ma200:     { label: 'MA200',     color: '#f59e0b', type: 'line', scaleId: 'right' },
        realized:  { label: '已实现价格', color: '#00d395', type: 'line', scaleId: 'right' },
        // 独立轴（非价格量纲）
        volume:    { label: '成交量',    color: '#6366f1', type: 'histogram', scaleId: 'vol' },
        rsi:       { label: 'RSI(14)',   color: '#f59e0b', type: 'line', scaleId: 'rsi' },
        mayer:     { label: 'Mayer',     color: '#06b6d4', type: 'line', scaleId: 'mayer' },
        mvrv:      { label: 'MVRV',      color: '#8b5cf6', type: 'line', scaleId: 'mvrv' },
        nupl:      { label: 'NUPL',      color: '#14b8a6', type: 'line', scaleId: 'nupl' },
        smm:       { label: 'SMM',       color: '#f7931a', type: 'line', scaleId: 'smm' },
        sec:       { label: '卖方衰竭',  color: '#ec4899', type: 'line', scaleId: 'sec' },
        rr:        { label: '风险回报',  color: '#22c55e', type: 'line', scaleId: 'rr' },
        etf:       { label: 'ETF净流入', color: '#06b6d4', type: 'histogram', scaleId: 'etf' },
        usdtd:     { label: 'USDT.D',   color: '#26a69a', type: 'line', scaleId: 'usdtd' },
        btcd:      { label: 'BTC.D',    color: '#42a5f5', type: 'line', scaleId: 'btcd' },
    },

    // ─── 初始化 ───────────────────────────────────────────────────
    init() {
        const mainEl = document.getElementById('tv-main');
        if (!mainEl) return;
        if (typeof LightweightCharts === 'undefined') {
            mainEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280;font-size:14px;">Lightweight Charts 库加载失败（需联网）</div>';
            return;
        }
        this._container = mainEl;

        const isDark = document.documentElement.classList.contains('dark');
        this.chart = LightweightCharts.createChart(mainEl, this._chartOptions(isDark));

        // K 线
        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#00d395', downColor: '#ff4757',
            borderUpColor: '#00d395', borderDownColor: '#ff4757',
            wickUpColor: '#00d395', wickDownColor: '#ff4757',
        });
        this.candleSeries.setData(this._getOHLC());

        // 默认开启成交量
        this._addIndicator('volume');

        this.chart.timeScale().fitContent();
        this._bindButtons();
        this._bindThemeObserver();
        this._bindLegend();
    },

    // ─── 时间周期切换 ─────────────────────────────────────────────
    setTimeframe(tf) {
        if (tf === this._timeframe) return;
        this._timeframe = tf;
        // 重新加载 K 线数据
        this.candleSeries.setData(this._getOHLC());
        // 重新加载所有已激活指标的数据
        for (const key of this.activeIndicators) {
            const data = this._getData(key);
            if (data && data.length) {
                this.indicators[key].series.setData(
                    this._colorizeIfNeeded(key, data)
                );
            }
        }
        this.chart.timeScale().fitContent();
        this._updateTimeframeButtons();
        // 刷新 legend 显示最新 bar
        this._showLegendForBar(this._getLastBar());
    },

    // ─── 对数坐标切换 ─────────────────────────────────────────────
    setLogScale(on) {
        this._logScale = on;
        this.chart.priceScale('right').applyOptions({
            mode: on ? LightweightCharts.PriceScaleMode.Logarithmic
                     : LightweightCharts.PriceScaleMode.Normal,
        });
        const btn = document.getElementById('tv-log-btn');
        if (btn) btn.classList.toggle('active', on);
    },

    // ─── 坐标翻转 ──────────────────────────────────────────────────
    toggleInvert(scaleId) {
        if (!this.chart) return;
        const inverted = this._invertedScales.has(scaleId);
        if (inverted) {
            this._invertedScales.delete(scaleId);
        } else {
            this._invertedScales.add(scaleId);
        }
        this.chart.priceScale(scaleId).applyOptions({ invertScale: !inverted });
        // 更新翻转按钮状态
        const btn = document.querySelector(`[data-tv-invert="${scaleId}"]`);
        if (btn) btn.classList.toggle('active', !inverted);
    },

    // ─── 指标开关 ──────────────────────────────────────────────────
    toggle(key) {
        if (this.indicators[key]) {
            this._removeIndicator(key);
        } else {
            this._addIndicator(key);
        }
        this._updateButton(key);
    },

    _addIndicator(key) {
        const cfg = this.INDICATORS[key];
        if (!cfg || !this.chart) return;

        const data = this._getData(key);
        if (!data || !data.length) return;

        let series;
        if (cfg.type === 'histogram') {
            series = this.chart.addHistogramSeries({
                color: cfg.color,
                priceScaleId: cfg.scaleId,
                priceFormat: cfg.scaleId === 'vol' ? { type: 'volume' } : { type: 'price', precision: 0, minMove: 1 },
            });
            series.setData(this._colorizeIfNeeded(key, data));
        } else {
            series = this.chart.addLineSeries({
                color: cfg.color,
                lineWidth: 1.5,
                priceScaleId: cfg.scaleId,
                lastValueVisible: true,
                priceLineVisible: false,
            });
            series.setData(data);
        }

        // 配置独立 priceScale（非主轴的指标）
        if (cfg.scaleId !== 'right') {
            const scaleOpts = {};
            if (cfg.scaleId === 'vol' || cfg.scaleId === 'etf') {
                // 成交量/ETF：压缩到底部 20%
                scaleOpts.scaleMargins = { top: 0.8, bottom: 0 };
                scaleOpts.visible = false;
            } else {
                // 其他指标（RSI/Mayer/MVRV等）：使用全区域，显示左侧刻度
                scaleOpts.scaleMargins = { top: 0.05, bottom: 0.05 };
                scaleOpts.visible = true;
                scaleOpts.alignLabels = true;
            }
            this.chart.priceScale(cfg.scaleId).applyOptions(scaleOpts);
        }

        this.indicators[key] = { series, scaleId: cfg.scaleId };
        this.activeIndicators.add(key);
    },

    _removeIndicator(key) {
        if (!this.indicators[key]) return;
        this.chart.removeSeries(this.indicators[key].series);
        delete this.indicators[key];
        this.activeIndicators.delete(key);
    },

    // ─── 直方图着色 ──────────────────────────────────────────────
    _colorizeIfNeeded(key, data) {
        if (key === 'volume') {
            const src = this._getSourceData();
            return data.map((d, i) => ({
                ...d,
                color: (src[i] && src[i].close >= src[i].open) ? 'rgba(0,211,149,0.25)' : 'rgba(255,71,87,0.25)',
            }));
        }
        if (key === 'etf') {
            return data.map(d => ({
                ...d,
                color: d.value >= 0 ? 'rgba(0,211,149,0.6)' : 'rgba(255,71,87,0.6)',
            }));
        }
        return data;
    },

    // ─── 数据准备 ─────────────────────────────────────────────────
    _getSourceData() {
        return this._timeframe === 'weekly'
            ? DataModule.aggregateWeekly(DataModule.processedData)
            : DataModule.processedData;
    },

    _getOHLC() {
        const data = this._getSourceData();
        return data.map(d => ({
            time: this._toDay(d.date),
            open: d.open, high: d.high, low: d.low, close: d.close,
        }));
    },

    /**
     * 将日粒度 {time, value}[] 聚合为周粒度（取每周最后一个值，时间对齐到周一）
     * 当 _timeframe === 'weekly' 且指标使用独立日期源时调用
     */
    _toWeekly(dailyData) {
        if (!dailyData || !dailyData.length) return dailyData;
        const weeks = new Map();
        for (const d of dailyData) {
            const dt = new Date(d.time);
            const day = dt.getUTCDay(); // 0=Sun, 1=Mon, ...
            const diff = (day === 0 ? 6 : day - 1); // 周一为一周起点
            const ms = dt.getTime() - diff * 86400000;
            const weekKey = new Date(ms).toISOString().slice(0, 10);
            // 取每周最后一条数据（覆盖即可，因为输入是时间升序）
            weeks.set(weekKey, { time: weekKey, value: d.value });
        }
        return Array.from(weeks.values());
    },

    /**
     * 将日粒度 ETF 流入聚合为周粒度（每周求和）
     */
    _toWeeklySum(dailyData) {
        if (!dailyData || !dailyData.length) return dailyData;
        const weeks = new Map();
        for (const d of dailyData) {
            const dt = new Date(d.time);
            const day = dt.getUTCDay();
            const diff = (day === 0 ? 6 : day - 1);
            const ms = dt.getTime() - diff * 86400000;
            const weekKey = new Date(ms).toISOString().slice(0, 10);
            if (!weeks.has(weekKey)) {
                weeks.set(weekKey, { time: weekKey, value: d.value });
            } else {
                weeks.get(weekKey).value += d.value;
            }
        }
        return Array.from(weeks.values());
    },

    _getData(key) {
        const data = this._getSourceData();
        const weekly = this._timeframe === 'weekly';
        switch (key) {
            case 'ma6': case 'ma103': case 'ma110': case 'ma200': {
                const period = { ma6: 6, ma103: 103, ma110: 110, ma200: 200 }[key];
                const ma = DataModule.calculateMA(data, period);
                return data.map((d, i) => ma[i] != null ? { time: this._toDay(d.date), value: ma[i] } : null).filter(Boolean);
            }
            case 'ema50': case 'ema110': {
                const period = key === 'ema50' ? 50 : 110;
                const alpha = 2 / (period + 1);
                const result = [];
                let prev = null;
                for (let i = 0; i < data.length; i++) {
                    const c = data[i].close;
                    prev = prev === null ? c : alpha * c + (1 - alpha) * prev;
                    if (i >= period - 1) {
                        result.push({ time: this._toDay(data[i].date), value: prev });
                    }
                }
                return result;
            }
            case 'realized': {
                const raw = DataModule.onchainData
                    .filter(d => d.realizedPrice != null)
                    .map(d => ({ time: this._toDay(d.date), value: d.realizedPrice }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            case 'volume': {
                return data.map(d => ({ time: this._toDay(d.date), value: d.volume }));
            }
            case 'rsi': {
                const rsi = DataModule.calculateRSI(data);
                return data.map((d, i) => rsi[i] != null ? { time: this._toDay(d.date), value: rsi[i] } : null).filter(Boolean);
            }
            case 'mayer': {
                const ma200 = DataModule.calculateMA(data, 200);
                return data.map((d, i) => ma200[i] ? { time: this._toDay(d.date), value: d.close / ma200[i] } : null).filter(Boolean);
            }
            case 'mvrv': {
                const raw = DataModule.onchainData
                    .filter(d => d.mvrv != null)
                    .map(d => ({ time: this._toDay(d.date), value: d.mvrv }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            case 'nupl': {
                const raw = DataModule.onchainData
                    .filter(d => d.nupl != null)
                    .map(d => ({ time: this._toDay(d.date), value: d.nupl }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            case 'smm': {
                const series = SmmModule._series || SmmModule.compute();
                if (!series) return [];
                const raw = series.map(d => ({ time: this._toDay(d.date), value: d.smm }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            case 'sec': {
                const se = DataModule.getSellerExhaustion();
                if (!se) return [];
                const raw = se.map(d => ({ time: this._toDay(d.date), value: d.sec }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            case 'rr': {
                const rr = DataModule.getRiskReward();
                if (!rr) return [];
                const raw = rr.filter(d => d && d.rr != null).map(d => ({ time: this._toDay(d.date), value: d.rr }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            case 'etf': {
                const raw = DataModule.etfData.map(d => ({ time: this._toDay(d.date), value: d.flow }));
                return weekly ? this._toWeeklySum(raw) : raw;
            }
            case 'usdtd': {
                const raw = DataModule.dominanceData
                    .filter(d => d.usdtD != null)
                    .map(d => ({ time: this._toDay(d.date), value: d.usdtD }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            case 'btcd': {
                const raw = DataModule.dominanceData
                    .filter(d => d.btcD != null)
                    .map(d => ({ time: this._toDay(d.date), value: d.btcD }));
                return weekly ? this._toWeekly(raw) : raw;
            }
            default: return [];
        }
    },

    // ─── Legend（鼠标悬浮显示 OHLC + 涨幅）────────────────────────
    _bindLegend() {
        this.chart.subscribeCrosshairMove(param => {
            if (!param.time || !param.seriesData || !param.seriesData.has(this.candleSeries)) {
                this._showLegendForBar(this._getLastBar());
                return;
            }
            const bar = param.seriesData.get(this.candleSeries);
            this._showLegendForBar(bar);
        });
        // 初始显示最新 bar
        this._showLegendForBar(this._getLastBar());
    },

    _getLastBar() {
        const ohlc = this._getOHLC();
        if (!ohlc.length) return null;
        const last = ohlc[ohlc.length - 1];
        return { open: last.open, high: last.high, low: last.low, close: last.close };
    },

    _showLegendForBar(bar) {
        const legend = document.getElementById('tv-legend');
        if (!legend || !bar) return;
        const chg = ((bar.close - bar.open) / bar.open * 100);
        const sign = chg >= 0 ? '+' : '';
        const color = chg >= 0 ? '#00d395' : '#ff4757';

        legend.querySelector('.tv-legend-o').textContent = `O: ${this._fmtPrice(bar.open)}`;
        legend.querySelector('.tv-legend-h').textContent = `H: ${this._fmtPrice(bar.high)}`;
        legend.querySelector('.tv-legend-l').textContent = `L: ${this._fmtPrice(bar.low)}`;
        legend.querySelector('.tv-legend-c').textContent = `C: ${this._fmtPrice(bar.close)}`;
        const chgEl = legend.querySelector('.tv-legend-chg');
        chgEl.textContent = `${sign}${chg.toFixed(2)}%`;
        chgEl.style.color = color;
    },

    _fmtPrice(v) {
        if (v == null) return '--';
        if (v >= 1000) return '$' + Math.round(v).toLocaleString();
        if (v >= 1) return '$' + v.toFixed(2);
        return '$' + v.toFixed(4);
    },

    // ─── 工具 ─────────────────────────────────────────────────────
    _toDay(date) {
        return date.toISOString().slice(0, 10);
    },

    _chartOptions(isDark) {
        return {
            autoSize: true,
            height: 560,
            layout: {
                background: { color: isDark ? '#0f0f23' : '#ffffff' },
                textColor: isDark ? '#9ca3af' : '#374151',
            },
            grid: {
                vertLines: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)' },
                horzLines: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)' },
            },
            timeScale: {
                borderColor: isDark ? '#374151' : '#e5e7eb',
                rightOffset: 5,
                timeVisible: false,
            },
            rightPriceScale: {
                borderColor: isDark ? '#374151' : '#e5e7eb',
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
            handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
            handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
        };
    },

    // ─── 按钮绑定 ─────────────────────────────────────────────────
    _bindButtons() {
        // 指标 toggle 按钮
        document.querySelectorAll('[data-tv-indicator]').forEach(btn => {
            btn.addEventListener('click', () => this.toggle(btn.dataset.tvIndicator));
        });
        // 初始状态：成交量按钮高亮
        this._updateButton('volume');

        // 时间周期按钮
        document.querySelectorAll('[data-tv-timeframe]').forEach(btn => {
            btn.addEventListener('click', () => this.setTimeframe(btn.dataset.tvTimeframe));
        });

        // 对数坐标按钮
        const logBtn = document.getElementById('tv-log-btn');
        if (logBtn) {
            logBtn.addEventListener('click', () => this.setLogScale(!this._logScale));
        }

        // 坐标翻转按钮
        document.querySelectorAll('[data-tv-invert]').forEach(btn => {
            btn.addEventListener('click', () => this.toggleInvert(btn.dataset.tvInvert));
        });
    },

    _updateButton(key) {
        const btn = document.querySelector(`[data-tv-indicator="${key}"]`);
        if (!btn) return;
        btn.classList.toggle('active', this.activeIndicators.has(key));
    },

    _updateTimeframeButtons() {
        document.querySelectorAll('[data-tv-timeframe]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tvTimeframe === this._timeframe);
        });
    },

    // ─── 主题跟随 ─────────────────────────────────────────────────
    _bindThemeObserver() {
        new MutationObserver(() => {
            const isDark = document.documentElement.classList.contains('dark');
            const opts = this._chartOptions(isDark);
            this.chart.applyOptions({ layout: opts.layout, grid: opts.grid });
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    },
};
