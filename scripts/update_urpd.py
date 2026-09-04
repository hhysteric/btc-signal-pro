#!/usr/bin/env python3
"""增量更新 URPD（UTXO Realized Price Age Distribution）CSV。

数据源 CryptoQuant（付费 API），拉取 5 个端点：
  1. utxo-age-distribution            → supply, supply_percent, supply_usd
  2. utxo-realized-price-age-distribution → cost_basis
  3. pnl-utxo                         → profit_percent（全局）
  4. utxo-realized-age-distribution    → realized_cap_usd, realized_cap_percent
  5. utxo-count-age-distribution       → utxo_count

输出 data/urpd.csv，每天 ~13 行（每个年龄段一行），降序排列。
增量模式：只追加比现有 CSV 更新的日期。
回填模式：--backfill 拉取 365 天全量历史。

用法:
    CRYPTOQUANT_KEY=xxxx python scripts/update_urpd.py
    CRYPTOQUANT_KEY=xxxx python scripts/update_urpd.py --backfill
"""
import datetime
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
CSV_PATH = os.path.join(DATA_DIR, "urpd.csv")
API_BASE = "https://api.cryptoquant.com/v1"

HEADER = ("date,band,label,supply,cost_basis,profit_percent,"
          "supply_percent,supply_usd,realized_cap_usd,realized_cap_percent,utxo_count")

# 年龄段 key → 可读标签
AGE_BANDS = [
    ("range_0d_1d",    "<1d"),
    ("range_1d_1w",    "1d-1w"),
    ("range_1w_1m",    "1w-1m"),
    ("range_1m_3m",    "1-3m"),
    ("range_3m_6m",    "3-6m"),
    ("range_6m_12m",   "6-12m"),
    ("range_12m_18m",  "1-1.5y"),
    ("range_18m_2y",   "1.5-2y"),
    ("range_2y_3y",    "2-3y"),
    ("range_3y_5y",    "3-5y"),
    ("range_5y_7y",    "5-7y"),
    ("range_7y_10y",   "7-10y"),
    ("range_10y_inf",  ">10y"),
]
AGE_KEYS = [k for k, _ in AGE_BANDS]
AGE_LABEL = dict(AGE_BANDS)


def http_get(url, key, timeout=60):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {key}",
        "User-Agent": "btc-cycle-dashboard/1.0",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_endpoint(path, key, limit=1):
    """拉取 CryptoQuant 端点，返回 data 数组（按日期降序）。"""
    url = f"{API_BASE}/{path}?window=day&limit={limit}"
    raw = http_get(url, key)
    data = json.loads(raw)
    if data.get("status", {}).get("code") != 200:
        raise RuntimeError(f"API error: {data.get('status')}")
    return data.get("result", {}).get("data", [])


def index_by_date(rows):
    """将 API 返回的行按日期索引为 {date_str: row}。"""
    out = {}
    for r in rows:
        d = r.get("date", "")[:10]
        if d:
            out[d] = r
    return out


def newest_date_in_csv():
    """读取现有 CSV 的最新日期。"""
    if not os.path.exists(CSV_PATH):
        return None
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        lines = [l.strip() for l in f if l.strip()]
    if len(lines) < 2:
        return None
    return lines[1].split(",")[0][:10]


def read_existing_rows():
    """读取现有 CSV 全部数据行（不含表头）。"""
    if not os.path.exists(CSV_PATH):
        return []
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    return lines[1:]  # 跳过表头


def val(row, field, default=""):
    """安全取值，None 时返回空字符串。"""
    v = row.get(field)
    return v if v is not None else default


def fetch_urpd_multi(key, limit):
    """拉取 5 个端点、合并成按日期分组的行列表。
    返回 [(date, profit_percent, bands_list), ...] 按日期降序。
    """
    print(f"正在拉取 CryptoQuant URPD 数据（limit={limit}）…")

    supply_rows = fetch_endpoint(
        "btc/network-indicator/utxo-age-distribution", key, limit)
    cost_rows = fetch_endpoint(
        "btc/market-indicator/utxo-realized-price-age-distribution", key, limit)

    # 这三个端点允许失败，不阻塞
    try:
        pnl_rows = fetch_endpoint(
            "btc/network-indicator/pnl-utxo", key, limit)
    except Exception as e:
        print(f"  pnl-utxo 失败（非致命）: {e}")
        pnl_rows = []

    try:
        rcap_rows = fetch_endpoint(
            "btc/network-indicator/utxo-realized-age-distribution", key, limit)
    except Exception as e:
        print(f"  realized-age-dist 失败（非致命）: {e}")
        rcap_rows = []

    try:
        count_rows = fetch_endpoint(
            "btc/network-indicator/utxo-count-age-distribution", key, limit)
    except Exception as e:
        print(f"  count-age-dist 失败（非致命）: {e}")
        count_rows = []

    supply_map = index_by_date(supply_rows)
    cost_map = index_by_date(cost_rows)
    pnl_map = index_by_date(pnl_rows)
    rcap_map = index_by_date(rcap_rows)
    count_map = index_by_date(count_rows)

    # 以 supply + cost 共同覆盖的日期为准
    all_dates = sorted(set(supply_map.keys()) & set(cost_map.keys()), reverse=True)
    print(f"  共 {len(all_dates)} 天有 supply+cost 数据")

    results = []
    for date_str in all_dates:
        s_row = supply_map[date_str]
        c_row = cost_map[date_str]
        p_row = pnl_map.get(date_str, {})
        r_row = rcap_map.get(date_str, {})
        ct_row = count_map.get(date_str, {})

        profit_percent = p_row.get("profit_percent")

        bands = []
        for band_key in AGE_KEYS:
            supply = s_row.get(band_key)
            cost_basis = c_row.get(band_key)
            if supply is None or cost_basis is None or supply <= 0:
                continue
            bands.append({
                "band": band_key,
                "label": AGE_LABEL[band_key],
                "supply": supply,
                "cost_basis": cost_basis,
                "supply_percent": val(s_row, f"{band_key}_percent"),
                "supply_usd": val(s_row, f"{band_key}_usd"),
                "realized_cap_usd": val(r_row, f"{band_key}_usd"),
                "realized_cap_percent": val(r_row, f"{band_key}_percent"),
                "utxo_count": val(ct_row, band_key),
            })
        # 按成本基础升序
        bands.sort(key=lambda b: b["cost_basis"])
        results.append((date_str, profit_percent, bands))

    return results


def write_csv(day_results, existing_rows):
    """写入 CSV：新数据在前（降序），已有旧数据在后。"""
    new_dates = {d for d, _, _ in day_results}

    new_rows = []
    for date_str, profit_percent, bands in day_results:
        pp = profit_percent if profit_percent is not None else ""
        for b in bands:
            new_rows.append(
                f"{date_str},{b['band']},{b['label']},"
                f"{b['supply']},{b['cost_basis']},{pp},"
                f"{b['supply_percent']},{b['supply_usd']},"
                f"{b['realized_cap_usd']},{b['realized_cap_percent']},"
                f"{b['utxo_count']}"
            )

    # 过滤掉已有行中重叠日期的行（幂等覆盖）
    old_rows = [r for r in existing_rows if r.split(",")[0][:10] not in new_dates]

    all_rows = [HEADER] + new_rows + old_rows
    with open(CSV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(all_rows) + "\n")

    total_days = len(new_dates)
    total_rows = len(new_rows)
    print(f"已写入 {total_rows} 行（{total_days} 天）到 {CSV_PATH}")


def main():
    key = os.environ.get("CRYPTOQUANT_KEY", "").strip()
    if not key:
        print("未设置 CRYPTOQUANT_KEY 环境变量，跳过 URPD 更新。")
        return 0

    backfill = "--backfill" in sys.argv

    if backfill:
        limit = 365
        print("回填模式：拉取 365 天历史")
    else:
        today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        newest = newest_date_in_csv()
        if newest and newest >= today:
            print(f"[urpd.csv] 已是最新（{newest}），无需更新")
            return 0
        # 增量：拉取从最新日期到今天的天数（+1 余量）
        if newest:
            delta = (datetime.date.fromisoformat(today) -
                     datetime.date.fromisoformat(newest)).days + 1
            limit = max(delta, 3)
        else:
            limit = 365  # 首次运行等同 backfill
        print(f"增量模式：拉取最近 {limit} 天")

    try:
        day_results = fetch_urpd_multi(key, limit)
    except Exception as e:
        print(f"URPD 数据拉取失败: {e}")
        return 1

    if not day_results:
        print("URPD 无有效数据")
        return 1

    existing = read_existing_rows()

    # 增量模式下只保留比现有更新的日期
    if not backfill:
        newest = newest_date_in_csv()
        if newest:
            day_results = [(d, p, b) for d, p, b in day_results if d > newest]
        if not day_results:
            print("无新数据需追加")
            return 0

    write_csv(day_results, existing)
    return 0


if __name__ == "__main__":
    sys.exit(main())
