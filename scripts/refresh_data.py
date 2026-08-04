#!/usr/bin/env python3
"""
팀오호츠크 대시보드 데이터 자동 갱신 스크립트.

Apps Script API에서 활성 종목 조회 → Yahoo Finance에서 시장 지수 8개(3개월 일봉)
+ 종목별 RSI(1개월 일봉) fetch → Google News RSS에서 종목별 뉴스 fetch →
data/data.json 저장.

GitHub Actions runner에서 실행되므로 IP 제한 없이 외부 API 자유 접근 가능.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

APPS_SCRIPT_URL = (
    "https://script.google.com/macros/s/"
    "AKfycbxUN2bEncv6DmZ5PqAslNdzk10ndH0NIMrtVXYfj8Vq-DZb9PAY8oObbP_8mDD0Ir1-Mg/exec"
)
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "data.json"

KST = timezone(timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (compatible; TeamOkhotskBot/1.0)"}

MARKET_INDICES = [
    {"name": "S&P500",        "ticker": "^GSPC",  "group": "미국 시장"},
    {"name": "NASDAQ",        "ticker": "^IXIC",  "group": "미국 시장"},
    {"name": "다우존스",       "ticker": "^DJI",   "group": "미국 시장"},
    {"name": "공포지수 VIX",   "ticker": "^VIX",   "group": "공포지수 VIX"},
    {"name": "미국10년금리",   "ticker": "^TNX",   "group": "환율 / 금리"},
    {"name": "원달러환율",     "ticker": "KRW=X",  "group": "환율 / 금리"},
    {"name": "KOSPI",         "ticker": "^KS11",  "group": "한국 시장"},
    {"name": "KOSDAQ",        "ticker": "^KQ11",  "group": "한국 시장"},
]

POS_RE = re.compile(
    r"surge|soar|jump|beat|rise|gain|high|record|strong|growth|profit|up|bull|rally",
    re.I,
)
NEG_RE = re.compile(
    r"fall|drop|plunge|miss|decline|loss|low|down|weak|cut|layoff|warn|concern|risk|sue|fine",
    re.I,
)


# ────────────────────────── Yahoo Finance ──────────────────────────
def fetch_yahoo_chart(ticker: str, range_: str = "3mo", interval: str = "1d") -> dict | None:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(ticker)}?range={range_}&interval={interval}"
    )
    try:
        r = requests.get(url, headers=UA, timeout=20)
        if r.status_code != 200:
            return None
        data = r.json()
    except Exception:
        return None
    result = (data.get("chart") or {}).get("result") or []
    if not result:
        return None
    r0 = result[0]
    closes = r0["indicators"]["quote"][0].get("close") or []
    timestamps = r0.get("timestamp") or []
    labels, series = [], []
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        labels.append(dt.strftime("%m/%d"))
        series.append(round(c, 2))
    return {"labels": labels, "series": series}


def build_market() -> dict:
    cards, groups_by_name = [], {}
    for idx in MARKET_INDICES:
        d = fetch_yahoo_chart(idx["ticker"], "3mo", "1d")
        if not d or len(d["series"]) < 2:
            print(f"  ⚠ market {idx['name']} ({idx['ticker']}) 실패")
            continue
        value, prev = d["series"][-1], d["series"][-2]
        change = round((value - prev) / prev * 100, 2) if prev else 0
        cards.append({"name": idx["name"], "value": value, "change": change})
        g = groups_by_name.setdefault(
            idx["group"],
            {"name": idx["group"], "labels": d["labels"], "series": []},
        )
        g["series"].append({"name": idx["name"], "data": d["series"]})
    return {"cards": cards, "groups": list(groups_by_name.values())}


# ────────────────────────── RSI ──────────────────────────
def compute_rsi(closes: list[float | None], period: int = 14) -> float | None:
    clean = [c for c in closes if c is not None]
    if len(clean) < period + 1:
        return None
    window = clean[-(period + 1):]
    gains = losses = 0.0
    for i in range(1, len(window)):
        d = window[i] - window[i - 1]
        if d > 0:
            gains += d
        else:
            losses -= d
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - 100 / (1 + rs), 1)


def fetch_rsi(ticker: str) -> float | None:
    d = fetch_yahoo_chart(ticker, "1mo", "1d")
    if not d:
        return None
    return compute_rsi(d["series"])


# ────────────────────────── Google News RSS ──────────────────────────
def fetch_news(ticker: str) -> list[dict]:
    q = urllib.parse.quote(f"{ticker} stock")
    url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
    try:
        r = requests.get(url, headers=UA, timeout=20)
        if r.status_code != 200:
            return []
        root = ET.fromstring(r.text)
    except Exception:
        return []
    channel = root.find("channel")
    if channel is None:
        return []
    out = []
    for it in channel.findall("item")[:4]:
        raw_title = (it.findtext("title") or "").strip()
        link = it.findtext("link") or ""
        pub = it.findtext("pubDate") or ""
        m = re.match(r"^(.*)\s[-–]\s([^-–]+)$", raw_title)
        title = (m.group(1) if m else raw_title).strip()
        publisher = m.group(2).strip() if m else ""
        date = ""
        try:
            dt = parsedate_to_datetime(pub).astimezone(KST)
            date = dt.strftime("%m/%d %H:%M")
        except Exception:
            pass
        lower = title.lower()
        if POS_RE.search(lower):
            sentiment = "positive"
        elif NEG_RE.search(lower):
            sentiment = "negative"
        else:
            sentiment = "neutral"
        out.append({
            "type": sentiment,
            "title": title,
            "publisher": publisher,
            "link": link,
            "date": date,
        })
    return out


# ────────────────────────── Apps Script → 활성 종목 ──────────────────────────
def collect_active_tickers() -> list[str]:
    try:
        r = requests.get(APPS_SCRIPT_URL, timeout=60)
        r.raise_for_status()
        d = r.json()
    except Exception as e:
        print(f"  ⚠ Apps Script fetch 실패: {e}")
        return []
    tickers = set()
    for s in d.get("seasons", []):
        for round_ in s.get("rounds", []):
            for st in round_.get("stocks", []):
                if not st.get("exitDate") and st.get("ticker"):
                    tickers.add(st["ticker"])
    return sorted(tickers)


# ────────────────────────── main ──────────────────────────
def main() -> int:
    started = datetime.now(timezone.utc)
    print(f"[{started.isoformat()}] refresh start")

    tickers = collect_active_tickers()
    print(f"활성 종목 {len(tickers)}개: {tickers}")

    print("시장 지수 fetch...")
    market = build_market()
    print(f"  cards={len(market['cards'])}, groups={len(market['groups'])}")

    print("종목별 RSI + 뉴스 fetch...")
    rsi_map, news_map = {}, {}
    for t in tickers:
        r_val = fetch_rsi(t)
        if r_val is not None:
            rsi_map[t] = r_val
        n_items = fetch_news(t)
        if n_items:
            news_map[t] = n_items
        print(f"  {t}: rsi={r_val}, news={len(n_items)}")

    output = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "market": market,
        "rsi": rsi_map,
        "news": news_map,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    size = OUTPUT_PATH.stat().st_size
    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    print(f"→ {OUTPUT_PATH} 저장 ({size:,} bytes, {elapsed:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
