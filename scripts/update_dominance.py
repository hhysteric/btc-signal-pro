#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Incremental update for BTC Dominance / USDT Dominance CSV.

Data source: CoinMarketCap public API (no API key required)
  - BTC.D + totalMarketCap: /data-api/v3/global-metrics/quotes/historical
  - USDT market cap: /data-api/v3/cryptocurrency/detail/chart?id=825&range=ALL
  - USDT.D = usdt_mcap / totalMarketCap * 100

BTC.D data available from 2013-04-29, USDT.D from ~2015.

Format: Datetime,BTC.D,USDT.D (comma-separated, descending order)

Usage:
    python scripts/update_dominance.py            # incremental update
    python scripts/update_dominance.py --backfill # full backfill
"""
import bisect
import datetime
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "data", "dominance.csv")
HEADER = "Datetime,BTC.D,USDT.D"

CMC_START = datetime.date(2013, 4, 29)
BATCH_DAYS = 2000  # safe value (API limit ~2200)

# Force UTF-8 stdout on Windows to avoid GBK codec errors
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def http_get(url, timeout=90):
    proxy = (os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
             or os.environ.get("https_proxy") or os.environ.get("http_proxy"))
    if proxy:
        handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy})
        opener = urllib.request.build_opener(handler)
    else:
        opener = urllib.request.build_opener()
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    })
    with opener.open(req, timeout=timeout) as r:
        return r.read()


# --- CMC global metrics (BTC.D + totalMarketCap) --------------------
def fetch_global_metrics(start_date, end_date):
    """Batch-fetch CMC global metrics history. Returns {date_iso: {btcD, totalMcap}}."""
    result = {}
    cursor = start_date
    while cursor <= end_date:
        batch_end = min(cursor + datetime.timedelta(days=BATCH_DAYS - 1), end_date)
        ts_start = int(datetime.datetime.combine(cursor, datetime.time(),
                                                  tzinfo=datetime.timezone.utc).timestamp())
        ts_end = int(datetime.datetime.combine(batch_end, datetime.time(23, 59, 59),
                                                tzinfo=datetime.timezone.utc).timestamp())
        url = (f"https://api.coinmarketcap.com/data-api/v3/global-metrics/quotes/historical"
               f"?format=chart_crypto_details&interval=1d"
               f"&timeStart={ts_start}&timeEnd={ts_end}")
        print(f"  Fetching global metrics: {cursor} ~ {batch_end} ...")
        try:
            raw = json.loads(http_get(url))
        except Exception as e:
            print(f"  [WARN] Fetch failed: {e}, skipping batch")
            cursor = batch_end + datetime.timedelta(days=1)
            time.sleep(3)
            continue

        quotes = raw.get("data", {}).get("quotes", [])
        for item in quotes:
            ts_str = item.get("timestamp", "")[:10]
            if not ts_str:
                continue
            btc_d = item.get("btcDominance")
            quote = item.get("quote", [{}])
            total_mcap = None
            if isinstance(quote, list) and len(quote) > 0:
                total_mcap = quote[0].get("totalMarketCap")
            elif isinstance(quote, dict):
                total_mcap = quote.get("totalMarketCap")
            if btc_d is not None:
                result[ts_str] = {"btcD": round(btc_d, 4), "totalMcap": total_mcap}

        print(f"  -> Cumulative {len(result)} days")
        cursor = batch_end + datetime.timedelta(days=1)
        time.sleep(2)

    return result


# --- USDT market cap (sampled history + daily interpolation) ---------
def fetch_usdt_mcap():
    """Fetch USDT historical market cap from CMC chart API.

    range=ALL returns ~700 sampled points (not daily). We linearly interpolate
    to produce daily values for every date that has a global-metrics entry.
    Returns {date_iso: mcap} with daily granularity.
    """
    url = "https://api.coinmarketcap.com/data-api/v3/cryptocurrency/detail/chart?id=825&range=ALL"
    print("  Fetching USDT market cap (range=ALL) ...")
    try:
        raw = json.loads(http_get(url, timeout=120))
    except Exception as e:
        print(f"  [WARN] USDT fetch failed: {e}")
        return {}

    points = raw.get("data", {}).get("points", {})

    # Parse raw timestamps into sorted (ordinal, mcap) pairs for interpolation
    samples = []
    for ts_str, val in points.items():
        try:
            ts = int(ts_str)
            dt = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).date()
            v_arr = val.get("v", [])
            if len(v_arr) >= 3 and v_arr[2] is not None and v_arr[2] > 0:
                samples.append((dt.toordinal(), v_arr[2]))
        except (ValueError, TypeError):
            continue

    if not samples:
        return {}

    samples.sort()
    ordinals = [s[0] for s in samples]
    mcaps = [s[1] for s in samples]
    print(f"  -> USDT: {len(samples)} sampled points, interpolating to daily ...")

    # Generate daily values from first to last sample date via linear interpolation
    result = {}
    first_ord, last_ord = ordinals[0], ordinals[-1]
    for d_ord in range(first_ord, last_ord + 1):
        idx = bisect.bisect_right(ordinals, d_ord)
        if idx == 0:
            val = mcaps[0]
        elif idx >= len(ordinals):
            val = mcaps[-1]
        elif ordinals[idx - 1] == d_ord:
            val = mcaps[idx - 1]
        else:
            # Linear interpolation between adjacent samples
            o1, o2 = ordinals[idx - 1], ordinals[idx]
            m1, m2 = mcaps[idx - 1], mcaps[idx]
            t = (d_ord - o1) / (o2 - o1) if o2 != o1 else 0
            val = m1 + t * (m2 - m1)
        day_iso = datetime.date.fromordinal(d_ord).isoformat()
        result[day_iso] = val

    print(f"  -> USDT: {len(result)} daily values ({datetime.date.fromordinal(first_ord)} ~ {datetime.date.fromordinal(last_ord)})")
    return result


# --- Merge BTC.D + USDT.D -------------------------------------------
def merge_data(global_metrics, usdt_mcaps):
    """Merge BTC.D (direct from CMC) and USDT.D (= usdt_mcap / totalMcap * 100).
    Returns [(date_iso, btcD, usdtD), ...] sorted ascending.
    """
    rows = []
    for day in sorted(global_metrics.keys()):
        gm = global_metrics[day]
        btc_d = gm["btcD"]

        usdt_d = None
        total_mcap = gm.get("totalMcap")
        usdt_mcap = usdt_mcaps.get(day)
        if total_mcap and usdt_mcap and total_mcap > 0:
            usdt_d = round(usdt_mcap / total_mcap * 100, 4)

        rows.append((day, btc_d, usdt_d))
    return rows


# --- CSV I/O ---------------------------------------------------------
def read_csv():
    if not os.path.exists(CSV_PATH):
        return HEADER, [], None
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    if len(lines) <= 1:
        return lines[0] if lines else HEADER, [], None
    return lines[0], lines[1:], lines[1].split(",")[0].strip()[:10]


def write_csv(header, rows):
    with open(CSV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + "\n")
        for r in rows:
            f.write(r + "\n")


def format_row(day, btc_d, usdt_d):
    ud = f"{usdt_d}" if usdt_d is not None else ""
    return f"{day},{btc_d},{ud}"


# --- Backfill / Incremental ------------------------------------------
def backfill():
    print("=== Backfill mode: fetching full Dominance history ===")
    today = datetime.datetime.now(datetime.timezone.utc).date()

    global_metrics = fetch_global_metrics(CMC_START, today)
    if not global_metrics:
        print("No data.")
        return 1

    usdt_mcaps = fetch_usdt_mcap()
    rows = merge_data(global_metrics, usdt_mcaps)
    if not rows:
        print("No data after merge.")
        return 1

    csv_rows = [format_row(d, b, u) for d, b, u in reversed(rows)]
    write_csv(HEADER, csv_rows)
    print(f"Wrote {len(csv_rows)} rows to {CSV_PATH}")

    with_usdt = sum(1 for _, _, u in rows if u is not None)
    print(f"  BTC.D: {rows[0][0]} ~ {rows[-1][0]} ({len(rows)} days)")
    print(f"  USDT.D: {with_usdt} days with data")
    return 0


def incremental():
    header, existing, newest = read_csv()
    today = datetime.datetime.now(datetime.timezone.utc).date()

    if newest:
        start = datetime.date.fromisoformat(newest) + datetime.timedelta(days=1)
        print(f"CSV latest: {newest} -> incremental {start} ~ {today}")
    else:
        print("CSV empty -> running full backfill")
        return backfill()

    if start > today:
        print("Already up to date.")
        return 0

    global_metrics = fetch_global_metrics(start, today)
    if not global_metrics:
        print("No new data.")
        return 0

    usdt_mcaps = fetch_usdt_mcap()
    rows = merge_data(global_metrics, usdt_mcaps)
    if not rows:
        print("No new data after merge.")
        return 0

    existing_dates = {r.split(",")[0].strip()[:10] for r in existing}
    new_rows = [(d, b, u) for d, b, u in rows if d not in existing_dates]
    if not new_rows:
        print("No new rows to append.")
        return 0

    new_csv = [format_row(d, b, u) for d, b, u in reversed(new_rows)]
    all_rows = new_csv + existing
    write_csv(HEADER, all_rows)
    print(f"Appended {len(new_rows)} days")
    return 0


def main():
    if "--backfill" in sys.argv:
        return backfill()
    return incremental()


if __name__ == "__main__":
    sys.exit(main())
