#!/usr/bin/env python3
"""FMS投稿を直近7日間で集計し、工区・路線ごとの通行リスクを生成する"""

import csv
import json
import math
import os
import re
import unicodedata
from datetime import datetime, timedelta

FMS_CSV = os.path.join(os.path.dirname(__file__), "..", "fms-data", "data", "analysis",
                       "fms_aomori_perfect_with_koku_merged_v2_latest.csv")
KOKU_GEOJSON = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "koku.geojson")
ROSEN_GEOJSON = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "rosen.geojson")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "fms_risk.json")

PERIOD_DAYS = 7  # 直近7日間を集計

# スタック危険度タグ（フロントエンドと同じ分類）
RISK_PATTERNS = [
    ("stacked",       re.compile(r"スタック|立ち往生|動け|はまっ|埋ま|出せな|出られ")),
    ("near_stack",    re.compile(r"空転|わだち|腹.*つ[かけ]|ガタガタ|バンパー|亀裂|段差|ひどい|やばい|ヤバ")),
    ("passable_slow", re.compile(r"すれ違|狭|通れ|歩道|通学|歩け|歩行|1車線|一車線")),
    ("resolved",      re.compile(r"きれい|感謝|ありがと|解消|入りました|除雪.*入っ|アスファルト.*見え")),
]

# 路線マッチングの最大距離（km）
ROSEN_MATCH_DISTANCE_KM = 0.3


def normalize_name(s):
    """全角英数字・記号を半角に正規化して比較用文字列を返す"""
    return unicodedata.normalize("NFKC", s).strip()


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


def haversine_km(lat1, lon1, lat2, lon2):
    """2点間の距離（km）"""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def point_to_line_min_distance(plat, plng, coords):
    """点からLineStringの各頂点への最短距離（km）。簡易版。"""
    min_d = float("inf")
    for c in coords:
        d = haversine_km(plat, plng, c[1], c[0])  # GeoJSON: [lng, lat]
        if d < min_d:
            min_d = d
    return min_d


def aggregate_risk(posts):
    """投稿リストからリスク集計を返す"""
    risk_counts = {"stacked": 0, "near_stack": 0, "passable_slow": 0, "resolved": 0, "info": 0}
    for row in posts:
        text = (row.get("title", "") + " " + row.get("description", "")).strip()
        tag = classify_risk(text)
        risk_counts[tag] += 1
    stuck_total = risk_counts["stacked"] + risk_counts["near_stack"]
    return risk_counts, stuck_total


def main():
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    period_start = today - timedelta(days=PERIOD_DAYS)

    # --- 工区GeoJSON ---
    with open(KOKU_GEOJSON, encoding="utf-8") as f:
        koku_data = json.load(f)

    koku_info = {}          # 表示名 → info
    koku_norm_to_name = {}  # 正規化名 → 表示名（逆引き用）
    for feat in koku_data["features"]:
        props = feat["properties"]
        name = props.get("名前", "")
        last_snow = parse_last_snow_date(props.get("最終除雪日", ""))
        days_since = (today - last_snow).days if last_snow else None
        koku_info[name] = {
            "shirei": props.get("指令", ""),
            "days_since_snow": days_since,
            "last_snow_date": props.get("最終除雪日", ""),
        }
        koku_norm_to_name[normalize_name(name)] = name

    # --- 路線GeoJSON ---
    with open(ROSEN_GEOJSON, encoding="utf-8") as f:
        rosen_data = json.load(f)

    # 路線名 → 座標リスト（重複名は座標を結合）
    rosen_coords = {}
    rosen_info = {}
    for feat in rosen_data["features"]:
        props = feat["properties"]
        name = props.get("名前", "")
        coords = feat["geometry"].get("coordinates", [])
        if name not in rosen_coords:
            rosen_coords[name] = []
            last_snow = parse_last_snow_date(props.get("最終除雪日", ""))
            days_since = (today - last_snow).days if last_snow else None
            rosen_info[name] = {
                "shirei": props.get("指令", ""),
                "days_since_snow": days_since,
                "last_snow_date": props.get("最終除雪日", ""),
            }
        rosen_coords[name].extend(coords)

    # --- FMS投稿読み込み（直近7日間のみ） ---
    if not os.path.exists(FMS_CSV):
        print(f"FMS CSVが見つかりません: {FMS_CSV}")
        print("既存のfms_risk.jsonを維持します。")
        return

    with open(FMS_CSV, encoding="utf-8-sig") as f:
        fms_rows = list(csv.DictReader(f))

    recent_posts = []
    for row in fms_rows:
        pub_date_str = row.get("pub_date", "")[:10]
        try:
            pub_date = datetime.strptime(pub_date_str, "%Y-%m-%d")
        except ValueError:
            continue
        if pub_date >= period_start:
            recent_posts.append(row)

    print(f"FMS全投稿: {len(fms_rows)}件")
    print(f"直近{PERIOD_DAYS}日間: {len(recent_posts)}件")
    print(f"工区数: {len(koku_info)}, 路線数: {len(rosen_coords)}")

    # --- 工区集計 ---
    koku_posts = {}  # 工区名 → [posts]
    unmatched_koku_posts = []  # 工区にマッチしなかった投稿

    for row in recent_posts:
        csv_koku = row.get("matched_koku", "").strip()
        # まず完全一致、次に正規化一致で照合
        if csv_koku and csv_koku in koku_info:
            koku_posts.setdefault(csv_koku, []).append(row)
        elif csv_koku:
            norm = normalize_name(csv_koku)
            display_name = koku_norm_to_name.get(norm)
            if display_name:
                koku_posts.setdefault(display_name, []).append(row)
            else:
                unmatched_koku_posts.append(row)
        else:
            unmatched_koku_posts.append(row)

    koku_result = {}
    for name, posts in koku_posts.items():
        risk_counts, stuck_total = aggregate_risk(posts)
        info = koku_info[name]
        koku_result[name] = {
            "category": "koku",
            "total": len(posts),
            "days_since_snow": info["days_since_snow"],
            "last_snow_date": info["last_snow_date"],
            "shirei": info["shirei"],
            "risk": risk_counts,
            "stuck_total": stuck_total,
            "resolved": risk_counts["resolved"],
        }

    print(f"工区マッチ: {len(koku_result)}工区, {sum(d['total'] for d in koku_result.values())}件")

    # --- 路線マッチ（工区にマッチしなかった投稿を路線に近接マッチ） ---
    rosen_posts = {}  # 路線名 → [posts]
    still_unmatched = []

    for row in unmatched_koku_posts:
        try:
            plat = float(row.get("latitude", 0))
            plng = float(row.get("longitude", 0))
        except (ValueError, TypeError):
            still_unmatched.append(row)
            continue

        if plat == 0 or plng == 0:
            still_unmatched.append(row)
            continue

        best_rosen = None
        best_dist = ROSEN_MATCH_DISTANCE_KM

        for rname, coords in rosen_coords.items():
            d = point_to_line_min_distance(plat, plng, coords)
            if d < best_dist:
                best_dist = d
                best_rosen = rname

        if best_rosen:
            rosen_posts.setdefault(best_rosen, []).append(row)
        else:
            still_unmatched.append(row)

    rosen_result = {}
    for name, posts in rosen_posts.items():
        risk_counts, stuck_total = aggregate_risk(posts)
        info = rosen_info[name]
        rosen_result[name] = {
            "category": "rosen",
            "total": len(posts),
            "days_since_snow": info["days_since_snow"],
            "last_snow_date": info["last_snow_date"],
            "shirei": info["shirei"],
            "risk": risk_counts,
            "stuck_total": stuck_total,
            "resolved": risk_counts["resolved"],
        }

    print(f"路線マッチ: {len(rosen_result)}路線, {sum(d['total'] for d in rosen_result.values())}件")
    print(f"未マッチ: {len(still_unmatched)}件")

    # --- 結合（工区優先、次に路線） ---
    all_areas = {}
    all_areas.update(koku_result)
    all_areas.update(rosen_result)

    # 上位表示
    top = sorted(all_areas.items(), key=lambda x: (x[1]["stuck_total"], x[1]["total"]), reverse=True)[:15]
    print(f"\nリスク上位:")
    for name, data in top:
        cat = "工区" if data["category"] == "koku" else "路線"
        snow = f"除雪{data['days_since_snow']}日前" if data["days_since_snow"] is not None else "除雪日不明"
        print(f"  [{cat}] {name}: スタック{data['stuck_total']}件 / 全{data['total']}件 ({snow})")

    # --- JSON出力 ---
    output = {
        "generated": today.strftime("%Y-%m-%d"),
        "period_days": PERIOD_DAYS,
        "summary": {
            "koku_count": len(koku_result),
            "rosen_count": len(rosen_result),
            "total_posts": sum(d["total"] for d in all_areas.values()),
            "unmatched_posts": len(still_unmatched),
        },
        "areas": all_areas,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False)
    print(f"\n保存: {OUT_PATH}")
    print(f"合計: {len(all_areas)}エリア（工区{len(koku_result)} + 路線{len(rosen_result)}）")


if __name__ == "__main__":
    main()
