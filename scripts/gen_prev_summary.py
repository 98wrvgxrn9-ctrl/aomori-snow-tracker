#!/usr/bin/env python3
"""前日の工区・路線ステータス集計を生成し prev_summary.json に保存する"""

import csv
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta

HISTORY_KOKU = os.path.join(os.path.dirname(__file__), "..", "data", "history_koku.csv")
HISTORY_ROSEN = os.path.join(os.path.dirname(__file__), "..", "data", "history_rosen.csv")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "prev_summary.json")


def classify_status(status):
    """フロントエンドと同じ分類ロジック"""
    if not status:
        return "other"
    s = status.strip()
    if "作業予定" in s or "出動" in s or "作業中" in s:
        return "scheduled"
    if "現場確認" in s:
        return "checking"
    if "日程調整" in s or "調整中" in s:
        return "adjusting"
    return "other"


def load_latest_by_date(path):
    """CSVからの日付ごとの最新スナップショットを返す"""
    with open(path, encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        rows = list(reader)

    # 日付＋時刻でグループ化
    by_datetime = defaultdict(list)
    for row in rows:
        if len(row) < 3:
            continue
        dt_str = row[0][:19]
        try:
            dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        by_datetime[dt_str].append(row)

    # 日付ごとに最新の取得時刻を選ぶ
    by_date = defaultdict(list)
    date_times = defaultdict(list)
    for dt_str in by_datetime:
        date_key = dt_str[:10]
        date_times[date_key].append(dt_str)

    result = {}
    for date_key, dts in date_times.items():
        latest_dt = max(dts)
        result[date_key] = by_datetime[latest_dt]

    return result


def count_statuses(rows):
    """ステータスごとのカウントを返す"""
    counts = {"scheduled": 0, "checking": 0, "adjusting": 0, "other": 0}
    for row in rows:
        status = row[2] if len(row) > 2 else ""
        cls = classify_status(status)
        counts[cls] += 1
    total = len(rows)
    return counts, total


def main():
    koku_by_date = load_latest_by_date(HISTORY_KOKU)
    rosen_by_date = load_latest_by_date(HISTORY_ROSEN)

    # 今日と前日を判定
    today = datetime.now().strftime("%Y-%m-%d")
    dates = sorted(koku_by_date.keys())

    # 前日 = 今日より前の最新日
    prev_dates = [d for d in dates if d < today]
    if not prev_dates:
        # 今日しかなければ直近2日を使う
        if len(dates) >= 2:
            prev_date = dates[-2]
        else:
            print("前日データなし")
            return
    else:
        prev_date = prev_dates[-1]

    print(f"今日: {today}, 前日: {prev_date}")

    koku_counts, koku_total = count_statuses(koku_by_date.get(prev_date, []))
    rosen_counts, rosen_total = count_statuses(rosen_by_date.get(prev_date, []))

    result = {
        "date": prev_date,
        "koku": {
            "total": koku_total,
            **koku_counts,
        },
        "rosen": {
            "total": rosen_total,
            **rosen_counts,
        },
    }

    print(f"工区: {koku_counts} / {koku_total}")
    print(f"路線: {rosen_counts} / {rosen_total}")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"保存: {OUT_PATH}")


if __name__ == "__main__":
    main()
