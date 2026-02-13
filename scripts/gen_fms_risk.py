#!/usr/bin/env python3
"""FMS投稿を指令継続期間に応じて集計し、工区ごとの通行リスクを生成する"""

import csv
import json
import os
import re
from datetime import datetime, timedelta

FMS_CSV = os.path.join(os.path.dirname(__file__), "..", "fms-data", "data", "analysis",
                       "fms_aomori_perfect_with_koku_merged_v2_latest.csv")
KOKU_GEOJSON = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "koku.geojson")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "fms_risk.json")

# スタック危険度タグ（フロントエンドと同じ分類）
RISK_PATTERNS = [
    ("stacked",       re.compile(r"スタック|立ち往生|動け|はまっ|埋ま|出せな|出られ")),
    ("near_stack",    re.compile(r"空転|わだち|腹.*つ[かけ]|ガタガタ|バンパー|亀裂|段差|ひどい|やばい|ヤバ")),
    ("passable_slow", re.compile(r"すれ違|狭|通れ|歩道|通学|歩け|歩行|1車線|一車線")),
    ("resolved",      re.compile(r"きれい|感謝|ありがと|解消|入りました|除雪.*入っ|アスファルト.*見え")),
]


def classify_risk(text):
    for key, pattern in RISK_PATTERNS:
        if pattern.search(text or ""):
            return key
    return "info"


def parse_last_snow_date(date_str, year=2026):
    """「2月11日」のような文字列をdatetimeに変換"""
    m = re.match(r"(\d+)月(\d+)日", (date_str or "").strip())
    if not m:
        return None
    month = int(m.group(1))
    day = int(m.group(2))
    try:
        return datetime(year, month, day)
    except ValueError:
        return None


def main():
    # 工区GeoJSONから最終除雪日を取得
    with open(KOKU_GEOJSON, encoding="utf-8") as f:
        koku_data = json.load(f)

    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

    koku_periods = {}  # 工区名 → (period_start, days_since)
    for feat in koku_data["features"]:
        props = feat["properties"]
        name = props.get("名前", "")
        last_snow = parse_last_snow_date(props.get("最終除雪日", ""))
        shirei = props.get("指令", "")

        if last_snow:
            days_since = (today - last_snow).days
            period_start = last_snow
        else:
            # 最終除雪日不明の場合、30日前をデフォルトに
            days_since = 30
            period_start = today - timedelta(days=30)

        koku_periods[name] = {
            "period_start": period_start,
            "days_since": days_since,
            "shirei": shirei,
        }

    # FMS投稿を読み込み
    with open(FMS_CSV, encoding="utf-8-sig") as f:
        fms_rows = list(csv.DictReader(f))

    print(f"FMS全投稿: {len(fms_rows)}件")
    print(f"工区数: {len(koku_periods)}")

    # 工区ごとに期間内のFMS投稿を集計
    result = {}
    total_matched = 0

    for koku_name, period_info in koku_periods.items():
        period_start = period_info["period_start"]
        days = period_info["days_since"]

        # この工区にマッチするFMS投稿を期間フィルタ
        matched_posts = []
        for row in fms_rows:
            if row.get("matched_koku") != koku_name:
                continue
            pub_date_str = row.get("pub_date", "")[:10]
            try:
                pub_date = datetime.strptime(pub_date_str, "%Y-%m-%d")
            except ValueError:
                continue
            if pub_date >= period_start:
                matched_posts.append(row)

        if not matched_posts:
            continue

        total_matched += len(matched_posts)

        # リスク分類
        risk_counts = {"stacked": 0, "near_stack": 0, "passable_slow": 0, "resolved": 0, "info": 0}
        for row in matched_posts:
            text = (row.get("title", "") + " " + row.get("description", "")).strip()
            tag = classify_risk(text)
            risk_counts[tag] += 1

        stuck_total = risk_counts["stacked"] + risk_counts["near_stack"]

        result[koku_name] = {
            "total": len(matched_posts),
            "days_since_snow": days,
            "shirei": period_info["shirei"],
            "risk": risk_counts,
            "stuck_total": stuck_total,
            "resolved": risk_counts["resolved"],
        }

    print(f"期間内マッチ投稿: {total_matched}件")
    print(f"リスクデータ生成: {len(result)}工区")

    # 上位を表示
    top = sorted(result.items(), key=lambda x: x[1]["stuck_total"], reverse=True)[:10]
    print("\nスタック報告上位:")
    for name, data in top:
        print(f"  {name}: スタック{data['stuck_total']}件 / 全{data['total']}件 (最終除雪{data['days_since_snow']}日前)")

    # JSON出力
    output = {
        "generated": today.strftime("%Y-%m-%d"),
        "areas": result,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False)
    print(f"\n保存: {OUT_PATH}")


if __name__ == "__main__":
    main()
