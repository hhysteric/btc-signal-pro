#!/usr/bin/env python3
"""增量更新 BTC 历史行情 CSV。

读取 data/btc_historical.csv 的最新日期，从可达的免费数据源拉取之后的日线
OHLCV 并追加（保持原格式：分号分隔、降序、最新在最上）。幂等：重复运行不会
重复写入已有日期。

数据源优先级（自动回退到第一个可达的）：
  1. Binance   (完整真实 OHLCV，BTCUSDT 自 2017-08-17 起)
  2. CoinGecko (完整 OHLC-ish，但很多网络环境会被限流/拦截)
  3. Blockchain.info market-price (仅收盘价，覆盖广、可达性好)

特殊模式:
  --backfill  一次性用 Binance 数据回填 2017-08-17 之后所有行的 OHLCV，
              保留原始 supply 值（Binance 不提供此字段），覆盖 CMC 的 OHLCV。

用法:
    python scripts/update_data.py            # 增量更新
    python scripts/update_data.py --backfill # 一次性回填历史 Binance 数据
"""
import csv
import datetime
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "data", "btc_historical.csv")
DAILY_ISSUANCE = 450  # 减半后（2024-）约每日新增 BTC，用于近似流通量
HEADER = ("timeOpen;timeClose;timeHigh;timeLow;name;open;high;low;close;"
          "volume;marketCap;circulatingSupply;timestamp")

# Binance BTCUSDT 上线日期
BINANCE_START = datetime.date(2017, 8, 17)


def http_get(url, timeout=30):
    # 优先用 requests（代理兼容性好），回退 urllib
    try:
        import requests as _req
        proxy = (os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
                 or os.environ.get("https_proxy") or os.environ.get("http_proxy"))
        proxies = {"https": proxy, "http": proxy} if proxy else None
        r = _req.get(url, timeout=timeout, proxies=proxies, verify=False,
                     headers={"User-Agent": "btc-cycle-dashboard/1.0"})
        r.raise_for_status()
        return r.content
    except ImportError:
        pass
    # fallback: urllib
    proxy = (os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
             or os.environ.get("https_proxy") or os.environ.get("http_proxy"))
    if proxy:
        handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy})
        opener = urllib.request.build_opener(handler)
    else:
        opener = urllib.request.build_opener()
    req = urllib.request.Request(url, headers={"User-Agent": "btc-cycle-dashboard/1.0"})
    with opener.open(req, timeout=timeout) as r:
        return r.read()


def read_csv():
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    return lines[0], lines[1:]  # header, rows (descending)


def date_of(row):
    return row.split(";")[0].strip('"')[:10]


# ─── Binance ─────────────────────────────────────────────────────────
# api.binance.com 的 SNI 在中国大陆被封锁，用备用域名自动回退
BINANCE_HOSTS = [
    "api1.binance.com",
    "api2.binance.com",
    "api3.binance.com",
    "data-api.binance.vision",
    "api.binance.com",        # 最后尝试主域名
]

def _pick_binance_host():
    """找到第一个可用的 Binance API 域名。"""
    for host in BINANCE_HOSTS:
        try:
            url = f"https://{host}/api/v3/ping"
            http_get(url, timeout=8)
            return host
        except Exception:
            continue
    return BINANCE_HOSTS[0]  # fallback

_binance_host = None

def fetch_binance_klines(start_date, end_date):
    """从 Binance 拉取 BTCUSDT 日线 OHLCV。

    返回 {date_iso: {open, high, low, close, volume}}，volume 为 quoteAssetVolume（USD 计）。
    自动分页（每次最多 1000 条）。
    """
    global _binance_host
    if _binance_host is None:
        _binance_host = _pick_binance_host()
        print(f"[Binance] 使用域名: {_binance_host}")

    result = {}
    start_ms = int(datetime.datetime.combine(start_date, datetime.time(),
                                              tzinfo=datetime.timezone.utc).timestamp() * 1000)
    end_ms = int(datetime.datetime.combine(end_date, datetime.time(23, 59, 59),
                                            tzinfo=datetime.timezone.utc).timestamp() * 1000)
    while start_ms <= end_ms:
        url = (f"https://{_binance_host}/api/v3/klines"
               f"?symbol=BTCUSDT&interval=1d&startTime={start_ms}&endTime={end_ms}&limit=1000")
        data = json.loads(http_get(url))
        if not data:
            break
        for k in data:
            # k = [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, ...]
            open_time_ms = k[0]
            dt = datetime.datetime.fromtimestamp(open_time_ms / 1000, datetime.timezone.utc)
            day = dt.date().isoformat()
            result[day] = {
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "volume": float(k[7]),  # quoteAssetVolume (USD)
            }
        # 下一页：最后一条的 closeTime + 1
        last_close_time = data[-1][6]
        start_ms = last_close_time + 1
        if len(data) < 1000:
            break
        time.sleep(0.2)  # 避免限流
    return result


def fetch_binance_new(start_date, end_date):
    """Binance 增量拉取：只返回完整 OHLCV dict。"""
    return fetch_binance_klines(start_date, end_date)


# ─── CoinGecko (fallback) ────────────────────────────────────────────
def fetch_closes_coingecko(start_date, end_date):
    """返回 {date_iso: close}。CoinGecko range API。"""
    frm = int(datetime.datetime.combine(start_date, datetime.time()).timestamp())
    to = int(datetime.datetime.combine(end_date, datetime.time(23, 59)).timestamp())
    url = ("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range"
           f"?vs_currency=usd&from={frm}&to={to}")
    data = json.loads(http_get(url))
    out = {}
    for ts_ms, price in data.get("prices", []):
        d = datetime.datetime.fromtimestamp(ts_ms / 1000, datetime.timezone.utc).date()
        out[d.isoformat()] = price  # 同日多点时保留最后一个（收盘近似）
    return out


# ─── Blockchain.info (fallback) ──────────────────────────────────────
def fetch_closes_blockchain(days=180):
    """返回 {date_iso: close}。Blockchain.info 仅收盘价。"""
    url = ("https://api.blockchain.info/charts/market-price"
           f"?timespan={days}days&format=json&sampled=false")
    data = json.loads(http_get(url))
    out = {}
    for v in data.get("values", []):
        d = datetime.datetime.fromtimestamp(v["x"], datetime.timezone.utc).date()
        out[d.isoformat()] = v["y"]
    return out


def fetch_new_data(newest_date, today):
    """依次尝试各数据源，返回 (source_name, data_dict, is_full_ohlcv)。

    Binance 返回完整 OHLCV dict: {date: {open,high,low,close,volume}}
    其他源仅返回 {date: close}，is_full_ohlcv=False。
    """
    span_days = (today - newest_date).days + 5
    start = newest_date + datetime.timedelta(days=1)

    # 1) Binance — 完整 OHLCV
    try:
        klines = fetch_binance_new(start, today)
        fresh = {d: v for d, v in klines.items()
                 if datetime.date.fromisoformat(d) > newest_date}
        if fresh:
            print(f"[数据源] Binance 可用，获取 {len(fresh)} 天新数据（完整 OHLCV）")
            return "Binance", fresh, True
        print("[数据源] Binance 可达但无新数据")
    except Exception as e:
        print(f"[数据源] Binance 不可用: {e}")

    # 2) CoinGecko — 仅 close
    try:
        closes = fetch_closes_coingecko(newest_date, today)
        fresh = {d: c for d, c in closes.items()
                 if datetime.date.fromisoformat(d) > newest_date}
        if fresh:
            print(f"[数据源] CoinGecko 可用，获取 {len(fresh)} 天新数据")
            return "CoinGecko", fresh, False
        print("[数据源] CoinGecko 可达但无新数据")
    except Exception as e:
        print(f"[数据源] CoinGecko 不可用: {e}")

    # 3) Blockchain.info — 仅 close
    try:
        closes = fetch_closes_blockchain(days=max(span_days, 30))
        fresh = {d: c for d, c in closes.items()
                 if datetime.date.fromisoformat(d) > newest_date}
        if fresh:
            print(f"[数据源] Blockchain.info 可用，获取 {len(fresh)} 天新数据")
            return "Blockchain.info", fresh, False
        print("[数据源] Blockchain.info 可达但无新数据")
    except Exception as e:
        print(f"[数据源] Blockchain.info 不可用: {e}")

    return None, {}, False


def build_rows(fresh, prev_close, supply, is_full_ohlcv=False):
    """把新数据构造成 CSV 行（升序）。

    is_full_ohlcv=True 时 fresh[date] = {open,high,low,close,volume}
    is_full_ohlcv=False 时 fresh[date] = close (number)
    """
    built = []
    for d in sorted(fresh):
        supply += DAILY_ISSUANCE

        if is_full_ohlcv:
            bar = fresh[d]
            o = round(bar["open"], 6)
            hi = round(bar["high"], 6)
            lo = round(bar["low"], 6)
            c = round(bar["close"], 6)
            vol = round(bar["volume"], 2)
        else:
            c = round(fresh[d], 6)
            o = round(prev_close, 6)
            hi = round(max(o, c) * 1.012, 6)
            lo = round(min(o, c) * 0.988, 6)
            vol = round(c * supply * 0.02, 2)

        mcap = round(c * supply, 2)
        iso = d + "T00:00:00.000Z"
        iso_c = d + "T23:59:59.999Z"
        row = ";".join([
            f'"{iso}"', f'"{iso_c}"', f'"{iso_c}"', f'"{iso}"', '"2781"',
            f"{o}", f"{hi}", f"{lo}", f"{c}", f"{vol}", f"{mcap}",
            f"{int(supply)}", f'"{iso_c}"',
        ])
        built.append(row)
        prev_close = c
    return built


# ─── 回填模式 ─────────────────────────────────────────────────────────
def backfill():
    """用 Binance 数据替换 2017-08-17 之后所有行的 OHLCV，保留原始 supply。"""
    print("=== 回填模式：用 Binance OHLCV 替换 2017-08-17 之后的 CMC 数据 ===")

    header, rows = read_csv()

    # 拉取 Binance 全部历史
    today = datetime.datetime.now(datetime.timezone.utc).date()
    print(f"从 Binance 拉取 {BINANCE_START} 至 {today} 的日线数据...")
    klines = fetch_binance_klines(BINANCE_START, today)
    print(f"获取到 {len(klines)} 天 Binance 数据")

    if not klines:
        print("Binance 无数据，回填中止。")
        return 1

    replaced = 0
    new_rows = []
    for row in rows:
        day = date_of(row)
        if day in klines:
            # 替换 OHLCV，保留 supply
            cols = row.split(";")
            bar = klines[day]
            cols[5] = str(round(bar["open"], 6))     # open
            cols[6] = str(round(bar["high"], 6))     # high
            cols[7] = str(round(bar["low"], 6))      # low
            cols[8] = str(round(bar["close"], 6))    # close
            cols[9] = str(round(bar["volume"], 2))   # volume (quoteAssetVolume)
            # marketCap = close × supply
            supply = float(cols[11])
            cols[10] = str(round(bar["close"] * supply, 2))
            new_rows.append(";".join(cols))
            replaced += 1
        else:
            new_rows.append(row)

    out = [header] + new_rows
    with open(CSV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("﻿")  # BOM
        f.write("\n".join(out) + "\n")

    print(f"回填完成：替换了 {replaced} 行（2017-08-17 之后），"
          f"保留 {len(new_rows) - replaced} 行原始数据（2017 之前）。")
    return 0


# ─── 增量更新（默认模式）─────────────────────────────────────────────
def main():
    if "--backfill" in sys.argv:
        return backfill()

    if not os.path.exists(CSV_PATH):
        print("找不到 CSV:", CSV_PATH)
        return 1

    header, rows = read_csv()
    newest_date = datetime.date.fromisoformat(date_of(rows[0]))
    today = datetime.datetime.now(datetime.timezone.utc).date()
    print(f"CSV 最新日期: {newest_date} | 今日(UTC): {today}")

    if newest_date >= today:
        print("已是最新，无需更新。")
        return 0

    newest_cols = rows[0].split(";")
    prev_close = float(newest_cols[8])
    supply = float(newest_cols[11])

    source, fresh, is_full = fetch_new_data(newest_date, today)
    if not fresh:
        print("没有可用的新数据，未修改 CSV。")
        return 0

    built = build_rows(fresh, prev_close, supply, is_full_ohlcv=is_full)
    built_desc = list(reversed(built))  # 降序插入到顶部
    out = [header] + built_desc + rows
    with open(CSV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("﻿")  # 保留 BOM
        f.write("\n".join(out) + "\n")

    print(f"已追加 {len(built)} 天（来源 {source}），"
          f"最新日期更新为 {date_of(built_desc[0])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
