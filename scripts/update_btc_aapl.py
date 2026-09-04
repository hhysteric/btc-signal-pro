#!/usr/bin/env python3
"""增量更新 BTC/AAPL 比率 CSV。

读取 data/btc_aapl.csv 的最新日期，从 Market Data API 拉取 AAPL 日线收盘价，
结合 data/btc_historical.csv 中的 BTC 收盘价，计算 BTC/AAPL 比率并追加。
保持原格式：逗号分隔、降序、最新在最上。幂等：重复运行不会重复写入已有日期。

数据源：
  - BTC 价格：data/btc_historical.csv（已有）
  - AAPL 价格：marketdata.app（免费、无 key、可达性好）

用法:
    python scripts/update_btc_aapl.py
"""
import datetime
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "data", "btc_aapl.csv")
BTC_CSV = os.path.join(ROOT, "data", "btc_historical.csv")
HEADER = "Datetime,AAPL Close,BTC Close,BTC/AAPL Ratio"


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "btc-cycle-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def read_csv(path):
    if not os.path.exists(path):
        return None, []
    with open(path, encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    if not lines:
        return None, []
    return lines[0], lines[1:]


def date_of(row):
    return row.split(",")[0][:10]


def load_btc_prices():
    """从 btc_historical.csv 加载 {date_iso: close}。"""
    prices = {}
    with open(BTC_CSV, encoding="utf-8-sig") as f:
        for i, line in enumerate(f):
            if i == 0:
                continue
            cols = line.strip().split(";")
            if len(cols) < 9:
                continue
            date_str = cols[0].replace('"', '')[:10]
            try:
                close = float(cols[8])
                prices[date_str] = close
            except (ValueError, IndexError):
                continue
    return prices


def fetch_aapl_marketdata(start_date, end_date):
    """从 marketdata.app 拉取 AAPL 日线收盘价，返回 {date_iso: close}。
    免费 API 无 key、CORS 友好、覆盖 2000 年至今。"""
    frm = start_date.isoformat()
    to = end_date.isoformat()
    url = (f"https://api.marketdata.app/v1/stocks/candles/daily/AAPL"
           f"?from={frm}&to={to}")
    data = json.loads(http_get(url))
    if data.get("s") != "ok":
        raise RuntimeError(f"API 返回非 ok: {data.get('s')} - {data}")
    timestamps = data.get("t", [])
    closes = data.get("c", [])
    out = {}
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        d = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date()
        out[d.isoformat()] = round(c, 2)
    return out


def main():
    if not os.path.exists(BTC_CSV):
        print("找不到 BTC CSV:", BTC_CSV)
        return 1

    # 加载 BTC 价格
    btc_prices = load_btc_prices()
    if not btc_prices:
        print("BTC 价格数据为空")
        return 1
    print(f"BTC 价格数据 {len(btc_prices)} 天")

    # 读取现有 CSV 或初始化
    header, rows = read_csv(CSV_PATH)
    if header is None:
        header = HEADER
        rows = []
        newest_date = datetime.date(2014, 12, 31)  # 初始化时从 2015 年开始
        print("初始化 BTC/AAPL CSV，从 2015-01-01 开始拉取")
    else:
        newest_date = datetime.date.fromisoformat(date_of(rows[0]))
        print(f"CSV 最新日期: {newest_date}")

    today = datetime.datetime.now(datetime.timezone.utc).date()
    if newest_date >= today:
        print("已是最新，无需更新。")
        return 0

    # 分批拉取 AAPL（每批最多 1 年，避免超时）
    start = newest_date + datetime.timedelta(days=1)
    all_aapl = {}
    current = start
    while current <= today:
        batch_end = min(current + datetime.timedelta(days=365), today)
        try:
            batch = fetch_aapl_marketdata(current, batch_end)
            all_aapl.update(batch)
            print(f"  [AAPL] {current} → {batch_end}: {len(batch)} 天")
        except Exception as e:
            print(f"  [AAPL] {current} → {batch_end} 失败: {e}")
        current = batch_end + datetime.timedelta(days=1)
        if current <= today:
            time.sleep(0.5)  # 避免限流

    if not all_aapl:
        print("没有获取到 AAPL 新数据")
        return 0

    # 计算 BTC/AAPL 比率：只保留两边都有数据的日期
    existing_dates = set(date_of(r) for r in rows)
    new_rows = []
    for d in sorted(all_aapl.keys()):
        if d in existing_dates:
            continue
        if d not in btc_prices:
            continue
        aapl = all_aapl[d]
        btc = btc_prices[d]
        ratio = round(btc / aapl, 2)
        new_rows.append(f"{d}T00:00:00Z,{aapl},{btc},{ratio}")

    if not new_rows:
        print("无新交集数据（AAPL 仅交易日有数据），未修改 CSV。")
        return 0

    new_rows_desc = list(reversed(new_rows))
    out = [header] + new_rows_desc + rows
    with open(CSV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")

    print(f"已追加 {len(new_rows)} 天，最新日期 {date_of(new_rows_desc[0])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
