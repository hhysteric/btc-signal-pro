#!/usr/bin/env python3
"""增量更新链上指标 CSV（MVRV Ratio、Realized Price、NUPL）——数据源 CryptoQuant。

读取 data/mvrv.csv / realized_price.csv / nupl.csv 的最新日期，从 CryptoQuant API
拉取之后的数据并追加（保持原格式：逗号分隔、降序、最新在最上、日期形如
2026-07-15T00:00:00Z）。幂等：重复运行不会重复写入已有日期。

CryptoQuant API key 从环境变量 CRYPTOQUANT_KEY 读取（GitHub Actions 里配为 Secret）。
**绝不硬编码 key**：前端源码公开，key 只能存在于服务端 Actions 环境。

用法:
    CRYPTOQUANT_KEY=xxxx python scripts/update_onchain.py
"""
import datetime
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
API_BASE = "https://api.cryptoquant.com/v1"

# 每个指标：本地文件、表头、CryptoQuant endpoint、返回 JSON 里的取值字段
SERIES = [
    {
        "file": "mvrv.csv",
        "header": "Datetime,MVRV Ratio",
        "endpoint": "btc/market-indicator/mvrv",
        "field": "mvrv",
    },
    {
        "file": "realized_price.csv",
        "header": "Datetime,Realized Price",
        "endpoint": "btc/market-indicator/realized-price",
        "field": "realized_price",
    },
    {
        "file": "nupl.csv",
        "header": "Datetime,Net Unrealized Profit/Loss (NUPL)",
        "endpoint": "btc/network-indicator/nupl",
        "field": "nupl",
    },
]


def http_get(url, key, timeout=30):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {key}",
        "User-Agent": "btc-cycle-dashboard/1.0",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def read_csv(path):
    with open(path, encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    return lines[0], lines[1:]  # header, rows (descending)


def date_of(row):
    return row.split(",")[0][:10]


def newest_valid_date(rows):
    for row in rows:
        cols = row.split(",")
        if len(cols) >= 2 and cols[1].strip():
            return datetime.date.fromisoformat(date_of(row))
    return None


def fetch_series(endpoint, field, key, start_date, today):
    """拉取 [start_date, today] 区间，返回 {date_iso: value}。CryptoQuant 用 from/to (YYYYMMDD)。"""
    frm = start_date.strftime("%Y%m%d")
    to = today.strftime("%Y%m%d")
    url = f"{API_BASE}/{endpoint}?window=day&from={frm}&to={to}&limit=100000"
    data = json.loads(http_get(url, key))
    if data.get("status", {}).get("code") != 200:
        raise RuntimeError(f"API status {data.get('status')}")
    out = {}
    for item in data.get("result", {}).get("data", []):
        d = item.get("date")
        v = item.get(field)
        if d and v is not None:
            out[d[:10]] = v
    return out


def update_one(series, key, today):
    path = os.path.join(DATA_DIR, series["file"])
    if not os.path.exists(path):
        print(f"[{series['file']}] 不存在，跳过")
        return False

    header, rows = read_csv(path)
    newest = newest_valid_date(rows)
    if newest is None:
        print(f"[{series['file']}] 无有效数据行，跳过")
        return False
    if newest >= today:
        print(f"[{series['file']}] 已是最新（{newest}），无需更新")
        return False

    try:
        fresh = fetch_series(series["endpoint"], series["field"], key,
                             newest + datetime.timedelta(days=1), today)
    except Exception as e:
        print(f"[{series['file']}] 数据源不可用: {e}")
        return False

    fresh = {d: v for d, v in fresh.items()
             if datetime.date.fromisoformat(d) > newest}
    if not fresh:
        print(f"[{series['file']}] 数据源可达但无新数据")
        return False

    new_rows = [f"{d}T00:00:00Z,{fresh[d]}" for d in sorted(fresh)]
    new_rows_desc = list(reversed(new_rows))
    out = [header] + new_rows_desc + rows
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")
    print(f"[{series['file']}] 已追加 {len(new_rows)} 天，最新 {date_of(new_rows_desc[0])}")
    return True


def main():
    key = os.environ.get("CRYPTOQUANT_KEY", "").strip()
    if not key:
        print("未设置 CRYPTOQUANT_KEY 环境变量，跳过链上更新。"
              "（GitHub Actions 里请在 Settings→Secrets 配置 CRYPTOQUANT_KEY）")
        return 0

    today = datetime.datetime.now(datetime.timezone.utc).date()
    print(f"今日(UTC): {today}")
    changed = False
    for series in SERIES:
        if update_one(series, key, today):
            changed = True
    print("有更新" if changed else "无更新")
    return 0


if __name__ == "__main__":
    sys.exit(main())
