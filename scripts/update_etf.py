#!/usr/bin/env python3
"""增量更新 BTC 现货 ETF 每日净流量 CSV，数据源 Farside。

Farside（farside.co.uk）是公开免费的美国现货比特币 ETF 资金流权威汇总，口径与
Glassnode 一致：先算各 ETF 持仓（BTC 数量）的日变化，再按纽约时间 16:00 左右的 BTC
美元收盘价折算为美元净流量（单位：百万美元 US$m）。本脚本抓取其汇总表，取每日 Total。

输出 data/etf_flow.csv，格式：逗号分隔、降序（最新在最上）、日期形如
2026-07-20T00:00:00Z，值为当日净流量（百万美元，正=净流入、负=净流出）。
幂等：重复运行不会重复写入已有日期。

Farside 有 Cloudflare，但带常规浏览器 UA 的普通 GET 可正常获取。GitHub Actions 服务端
一般可达；若某日被拦截，脚本安全跳过、不改 CSV。

用法:
    python scripts/update_etf.py
"""
import datetime
import os
import re
import sys
import html as htmllib
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "data", "etf_flow.csv")
HEADER = "Datetime,ETF Net Flow (USD mn)"
URL = "https://farside.co.uk/bitcoin-etf-flow-all-data/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def http_get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def parse_farside(page):
    """从 Farside 汇总表解析 {date_iso: total_flow_musd}。取每行最后一列(Total)。"""
    out = {}
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S)
    for r in rows:
        cells = [htmllib.unescape(re.sub(r"<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, re.S)]
        if not cells:
            continue
        m = re.match(r"(\d{1,2}) (\w{3}) (\d{4})$", cells[0])
        if not m:
            continue
        d, mon, y = int(m.group(1)), m.group(2), int(m.group(3))
        if mon not in MONTHS:
            continue
        total_raw = cells[-1].replace(",", "").replace("(", "-").replace(")", "")
        if total_raw in ("", "-", "—"):
            continue
        try:
            total = float(total_raw)
        except ValueError:
            continue
        iso = datetime.date(y, MONTHS[mon], d).isoformat()
        out[iso] = total
    return out


def read_csv():
    if not os.path.exists(CSV_PATH):
        return HEADER, []
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]
    return lines[0], lines[1:]


def newest_date(rows):
    for row in rows:
        cols = row.split(",")
        if len(cols) >= 2 and cols[1].strip():
            return datetime.date.fromisoformat(cols[0][:10])
    return None


def main():
    try:
        page = http_get(URL)
    except Exception as e:
        print(f"[etf_flow] 抓取失败（可能被 Cloudflare 拦截），跳过: {e}")
        return 0
    flows = parse_farside(page)
    if not flows:
        print("[etf_flow] 未解析到数据，跳过（页面结构可能变化或被拦截）。")
        return 0

    header, rows = read_csv()
    newest = newest_date(rows)
    fresh = {d: v for d, v in flows.items()
             if newest is None or datetime.date.fromisoformat(d) > newest}
    if not fresh:
        print(f"[etf_flow] 已是最新（{newest}），无新数据。")
        return 0

    new_rows = [f"{d}T00:00:00Z,{fresh[d]}" for d in sorted(fresh)]
    new_rows_desc = list(reversed(new_rows))
    out = [header] + new_rows_desc + rows
    with open(CSV_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out) + "\n")
    print(f"[etf_flow] 已追加 {len(new_rows)} 天，最新 {new_rows_desc[0][:10]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
