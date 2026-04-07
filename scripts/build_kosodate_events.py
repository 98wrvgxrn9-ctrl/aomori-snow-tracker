#!/usr/bin/env python3
"""Build kids-learning map event feed from master data.

Default window keeps the current month + next 2 months.
Run biweekly to refresh docs/data/kosodate_events.json and flag stale feeds.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = ROOT / "scripts" / "kosodate_events_master.json"
OUTPUT_PATH = ROOT / "docs" / "data" / "kosodate_events.json"


def parse_iso_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def first_day_of_month(d: date) -> date:
    return d.replace(day=1)


def add_months(d: date, months: int) -> date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    return d.replace(year=y, month=m, day=1)


def last_day_of_month(d: date) -> date:
    next_month = add_months(first_day_of_month(d), 1)
    return next_month - timedelta(days=1)


def build_window(today: date, future_months: int) -> tuple[date, date]:
    start = first_day_of_month(today)
    end = last_day_of_month(add_months(start, future_months - 1))
    return start, end


def in_window(item: dict, start: date, end: date) -> bool:
    s = parse_iso_date(item["event_start_date"])
    e = parse_iso_date(item["event_end_date"])
    return not (e < start or s > end)


def is_recurring_event(item: dict) -> bool:
    txt = f'{item.get("month", "")} {item.get("time", "")}'
    return "毎月" in txt or "毎週" in txt or "通年" in txt or "4月-3月" in txt


def build_monitoring(today: date, items: list[dict], interval_days: int, recent_days: int) -> dict:
    recent_end = today + timedelta(days=recent_days)
    dated_items = [
        item
        for item in items
        if not is_recurring_event(item)
        and not (
            parse_iso_date(item["event_end_date"]) < today
            or parse_iso_date(item["event_start_date"]) > recent_end
        )
    ]
    latest_event_date = max((item.get("event_end_date") for item in items), default=None)
    status = "ok" if dated_items else "attention"
    if dated_items:
        note = f"直近{recent_days}日に単発系イベントが{len(dated_items)}件あります。"
    else:
        note = f"直近{recent_days}日に単発系イベントがないため、元ページ確認を推奨します。"
    return {
        "checked_at": today.isoformat(),
        "next_check_at": (today + timedelta(days=interval_days)).isoformat(),
        "check_interval_days": interval_days,
        "recent_days": recent_days,
        "recent_non_recurring_count": len(dated_items),
        "latest_event_date": latest_event_date,
        "status": status,
        "note": note,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--future-months",
        type=int,
        default=3,
        help="How many months to include from current month (default: 3)",
    )
    parser.add_argument(
        "--monitor-interval-days",
        type=int,
        default=14,
        help="Expected monitoring cadence in days (default: 14)",
    )
    parser.add_argument(
        "--recent-days",
        type=int,
        default=30,
        help="How many days to check for near-term dated events (default: 30)",
    )
    args = parser.parse_args()

    today = date.today()
    start, end = build_window(today, args.future_months)

    master = json.loads(MASTER_PATH.read_text(encoding="utf-8"))
    items = master.get("items", [])
    filtered = [x for x in items if in_window(x, start, end)]
    filtered.sort(key=lambda x: (x.get("event_start_date", ""), x.get("category", ""), x.get("title", "")))

    out = {
        "updated_at": today.isoformat(),
        "monitoring": build_monitoring(
            today,
            filtered,
            interval_days=args.monitor_interval_days,
            recent_days=args.recent_days,
        ),
        "window": {
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "future_months": args.future_months,
            "note": "Run this script every 2 weeks to refresh the rolling window.",
        },
        "items": filtered,
    }
    OUTPUT_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT_PATH} ({len(filtered)} items)")


if __name__ == "__main__":
    main()
