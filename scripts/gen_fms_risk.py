#!/usr/bin/env python3
"""FMS投稿を直近7日間で集計し、工区・路線ごとの通行リスクを生成する"""

import csv
import json
import math
import os
import re
import unicodedata
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

SCRIPT_DIR = os.path.dirname(__file__)

# Google Spreadsheet (FMS通知記録)
FMS_SPREADSHEET_ID = "148iiDmslhzgn65nQCZG9Lk3Dobr7pEzkjBqcIK92aq0"
FMS_CSV_CANDIDATES = [
    os.environ.get("FMS_CSV_PATH", ""),
    os.path.join(SCRIPT_DIR, "..", "data", "processed", "fms",
                 "fms_aomori_perfect_with_koku_merged_v2_latest.csv"),
    os.path.join(SCRIPT_DIR, "..", "fms-data", "data", "analysis",
                 "fms_aomori_perfect_with_koku_merged_v2_latest.csv"),
    os.path.join(SCRIPT_DIR, "..", "fms-data", "data", "by_prefecture",
                 "2_青森県.csv"),
    os.path.join(SCRIPT_DIR, "..", "fms-data", "data", "by_prefecture",
                 "2_青森県_with_coordinates.csv"),
    os.path.join(SCRIPT_DIR, "..", "fms-data", "data", "analysis",
                 "fms_aomori_perfect_with_koku.csv"),
]
def _resolve_path(*candidates):
    """候補パスから最初に存在するものを返す。なければ最後の候補を返す。"""
    for p in candidates:
        if os.path.exists(p):
            return p
    return candidates[-1]

KOKU_GEOJSON = _resolve_path(
    os.path.join(SCRIPT_DIR, "..", "data", "processed", "koku.geojson"),
    os.path.join(SCRIPT_DIR, "..", "docs", "data", "koku.geojson"),
)
ROSEN_GEOJSON = _resolve_path(
    os.path.join(SCRIPT_DIR, "..", "data", "processed", "rosen.geojson"),
    os.path.join(SCRIPT_DIR, "..", "docs", "data", "rosen.geojson"),
)
OUT_PATH = _resolve_path(
    os.path.join(SCRIPT_DIR, "..", "data", "processed", "fms_risk.json"),
    os.path.join(SCRIPT_DIR, "..", "docs", "data", "fms_risk.json"),
)

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


def polygon_centroid(coordinates):
    """GeoJSONポリゴン座標から重心を計算。返り値は (lat, lng)。"""
    ring = coordinates[0]  # 外周リングのみ使用
    n = len(ring)
    if n == 0:
        return (0, 0)
    avg_lng = sum(c[0] for c in ring) / n
    avg_lat = sum(c[1] for c in ring) / n
    return (avg_lat, avg_lng)


KOKU_MATCH_DISTANCE_KM = 5.0  # 座標→工区マッチングの最大距離


def resolve_fms_csv():
    """優先順位でFMS CSVファイルを探す。見つかったパスを返す。"""
    for path in FMS_CSV_CANDIDATES:
        if path and os.path.exists(path):
            return path
    return None


def fetch_fms_from_spreadsheet():
    """Google SpreadsheetからFMS投稿データを読み取る。返り値は dict のリスト or None。"""
    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if not creds_json:
        return None

    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        print("gspread/google-auth未インストール。スプシ読み取りスキップ。")
        return None

    try:
        # base64エンコード済みの場合はデコード、そうでなければそのままパース
        import base64
        try:
            decoded = base64.b64decode(creds_json).decode("utf-8")
            creds_data = json.loads(decoded)
        except Exception:
            creds_data = json.loads(creds_json)
        creds = Credentials.from_service_account_info(
            creds_data,
            scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"],
        )
        client = gspread.authorize(creds)
        sheet = client.open_by_key(FMS_SPREADSHEET_ID).sheet1
        raw_rows = sheet.get_all_records()
        print(f"スプシから{len(raw_rows)}件取得")

        # カラム名の末尾スペースを除去して正規化
        rows = [{k.strip(): v for k, v in row.items()} for row in raw_rows]

        # スプシのカラム名をgen_fms_risk.pyの期待する形式に変換
        posts = []
        for row in rows:
            status = str(row.get("status", ""))
            if status == "削除済み":
                continue
            lat = str(row.get("latitude", "")).strip()
            lng = str(row.get("longtitude", row.get("longitude", ""))).strip()
            if not lat or not lng:
                continue
            posts.append({
                "pub_date": str(row.get("received_at", "")),
                "title": str(row.get("subject", "")),
                "description": "",
                "latitude": lat,
                "longitude": lng,
                "link": str(row.get("report_url", "")),
            })
        return posts
    except Exception as e:
        print(f"スプシ読み取りエラー: {e}")
        return None


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
    # 優先順位: 1. スプシ  2. ローカルCSV
    fms_rows = None
    source_label = ""

    spreadsheet_posts = fetch_fms_from_spreadsheet()
    if spreadsheet_posts:
        fms_rows = spreadsheet_posts
        source_label = "スプシ"
    else:
        fms_csv_path = resolve_fms_csv()
        if fms_csv_path:
            print(f"FMS CSV: {fms_csv_path}")
            with open(fms_csv_path, encoding="utf-8-sig") as f:
                fms_rows = list(csv.DictReader(f))
            source_label = "CSV"

    if not fms_rows:
        print("FMSデータが見つかりません。既存のfms_risk.jsonを維持します。")
        return

    def parse_pub_date(s):
        """複数の日付形式に対応"""
        s = str(s).strip()
        if not s:
            return None
        # ISO形式 "2026-02-10" or "2026-02-10 12:34:56"
        try:
            return datetime.strptime(s[:10], "%Y-%m-%d")
        except ValueError:
            pass
        # スプシ形式 "2026/02/16 23:54:37"
        try:
            return datetime.strptime(s[:10], "%Y/%m/%d")
        except ValueError:
            pass
        # RFC 2822形式 "Thu, 25 Dec 2025 03:45:18 GMT"
        try:
            return parsedate_to_datetime(s).replace(tzinfo=None)
        except (ValueError, TypeError):
            pass
        return None

    recent_posts = []
    for row in fms_rows:
        pub_date = parse_pub_date(row.get("pub_date", ""))
        if pub_date and pub_date >= period_start:
            recent_posts.append(row)

    print(f"FMSソース: {source_label} ({len(fms_rows)}件)")
    print(f"直近{PERIOD_DAYS}日間: {len(recent_posts)}件")
    print(f"工区数: {len(koku_info)}, 路線数: {len(rosen_coords)}")

    # --- 工区集計 ---
    # CSVに matched_koku 列があるか判定
    has_matched_koku = "matched_koku" in recent_posts[0] if recent_posts else False
    if not has_matched_koku:
        print("matched_koku列なし → 座標ベースで工区マッチングを実行")

    # 座標マッチ用: 工区名→重心座標を事前計算
    koku_centroids = {}  # 工区名 → (lat, lng)
    for feat in koku_data["features"]:
        name = feat["properties"].get("名前", "")
        if name and feat["geometry"]["type"] == "Polygon":
            koku_centroids[name] = polygon_centroid(feat["geometry"]["coordinates"])

    koku_posts = {}  # 工区名 → [posts]
    unmatched_koku_posts = []  # 工区にマッチしなかった投稿

    for row in recent_posts:
        if has_matched_koku:
            # 既存ロジック: matched_koku列を使用
            csv_koku = row.get("matched_koku", "").strip()
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
        else:
            # 座標ベースマッチング: 投稿座標→最寄り工区重心
            try:
                plat = float(row.get("latitude", 0))
                plng = float(row.get("longitude", 0))
            except (ValueError, TypeError):
                unmatched_koku_posts.append(row)
                continue

            if plat == 0 or plng == 0:
                unmatched_koku_posts.append(row)
                continue

            best_koku = None
            best_dist = KOKU_MATCH_DISTANCE_KM

            for kname, (clat, clng) in koku_centroids.items():
                d = haversine_km(plat, plng, clat, clng)
                if d < best_dist:
                    best_dist = d
                    best_koku = kname

            if best_koku:
                koku_posts.setdefault(best_koku, []).append(row)
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
