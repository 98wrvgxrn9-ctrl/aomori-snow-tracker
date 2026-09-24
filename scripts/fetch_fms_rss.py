#!/usr/bin/env python3
"""FMS(FixMyStreet)青森市のRSSフィードから投稿を取得し、CSVに蓄積する。

GASメール通知に依存しない代替データ収集手段。
出力: data/fms_posts.csv

使い方:
  python scripts/fetch_fms_rss.py                 # 直近30日分を座標付きで取得
  python scripts/fetch_fms_rss.py --days 7        # 直近7日分のみ
  python scripts/fetch_fms_rss.py --no-coords     # 座標取得をスキップ（高速）
  python scripts/fetch_fms_rss.py --all           # 全件取得（初回インポート用）
"""

import argparse
import csv
import os
import re
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RSS_URL = "https://www.fixmystreet.jp/feed/cities/02201"
OUT_CSV = os.path.join(SCRIPT_DIR, "..", "data", "fms_posts.csv")

CSV_COLUMNS = [
    "report_id",
    "pub_date",
    "title",
    "description",
    "report_url",
    "latitude",
    "longitude",
    "status",
    "fetched_at",
]

USER_AGENT = "AomoriSnowTracker/1.0 (+https://github.com/98wrvgxrn9-ctrl/aomori-snow-tracker)"
DEFAULT_DAYS = 30
COORD_DELAY_SEC = 1.0  # ページ取得間隔（サーバー負荷軽減）


def fetch_url(url, timeout=20):
    """URLからテキストを取得"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        charset = res.headers.get_content_charset() or "utf-8"
        return res.read().decode(charset, errors="replace")


def fetch_coordinates(report_url):
    """FMS投稿ページから座標を抽出する。取得失敗時は (None, None)。"""
    try:
        html = fetch_url(report_url)
    except Exception as e:
        print(f"  座標取得失敗 ({report_url}): {e}")
        return None, None

    # パターン1: Google Maps query=lat,lng
    m = re.search(r"query=([0-9.]+),([0-9.]+)", html)
    if m:
        return m.group(1), m.group(2)

    # パターン2: og:latitude / og:longitude メタタグ
    lat_m = re.search(r'<meta\s+property="og:latitude"\s+content="([^"]+)"', html, re.I)
    lng_m = re.search(r'<meta\s+property="og:longitude"\s+content="([^"]+)"', html, re.I)
    if lat_m and lng_m:
        return lat_m.group(1), lng_m.group(1)

    # パターン3: JSON風の latitude/longitude
    m = re.search(r'latitude["\s:]+([0-9.]+)[,\s]+longitude["\s:]+([0-9.]+)', html, re.I)
    if m:
        return m.group(1), m.group(2)

    return None, None


def load_existing_ids():
    """既存CSVからreport_idのセットを読み込む"""
    if not os.path.exists(OUT_CSV):
        return set()
    ids = set()
    with open(OUT_CSV, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid = row.get("report_id", "").strip()
            if rid:
                ids.add(rid)
    return ids


def parse_rss(xml_text):
    """RSSをパースして投稿リストを返す"""
    root = ET.fromstring(xml_text)
    items = []
    for item_el in root.iter("item"):
        title = (item_el.findtext("title") or "").strip()
        link = (item_el.findtext("link") or "").strip()
        desc = (item_el.findtext("description") or "").strip()
        pub_date_str = item_el.findtext("pubDate") or ""

        # report_id をURLから抽出
        id_match = re.search(r"/reports/(\d+)", link)
        report_id = id_match.group(1) if id_match else ""

        # 日付パース
        pub_date = ""
        if pub_date_str:
            try:
                dt = parsedate_to_datetime(pub_date_str)
                pub_date = dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pub_date = pub_date_str

        items.append({
            "report_id": report_id,
            "pub_date": pub_date,
            "title": title,
            "description": desc,
            "report_url": link,
        })
    return items


def filter_by_days(items, days):
    """直近N日以内の投稿のみ返す"""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    filtered = []
    for item in items:
        if not item["pub_date"]:
            continue
        try:
            dt = datetime.strptime(item["pub_date"], "%Y-%m-%d %H:%M:%S")
            dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if dt >= cutoff:
            filtered.append(item)
    return filtered


def main():
    parser = argparse.ArgumentParser(description="FMS青森市RSS→CSV取得")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS,
                        help=f"直近N日分のみ取得（デフォルト: {DEFAULT_DAYS}）")
    parser.add_argument("--all", action="store_true",
                        help="全件取得（日数フィルタなし）")
    parser.add_argument("--no-coords", action="store_true",
                        help="座標取得をスキップ（高速モード）")
    args = parser.parse_args()

    print(f"RSS取得中: {RSS_URL}")
    xml_text = fetch_url(RSS_URL)
    items = parse_rss(xml_text)
    print(f"  RSSアイテム数: {len(items)}")

    # 日数フィルタ
    if not args.all:
        items = filter_by_days(items, args.days)
        print(f"  直近{args.days}日分: {len(items)}件")

    existing_ids = load_existing_ids()
    print(f"  既存レコード数: {len(existing_ids)}")

    new_items = [it for it in items if it["report_id"] and it["report_id"] not in existing_ids]
    print(f"  新規投稿数: {len(new_items)}")

    if not new_items:
        print("新規投稿なし。終了。")
        return

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    # 座標取得
    for i, item in enumerate(new_items):
        if not args.no_coords and item["report_url"]:
            print(f"  [{i+1}/{len(new_items)}] 座標取得: {item['title']}")
            lat, lng = fetch_coordinates(item["report_url"])
            item["latitude"] = lat or ""
            item["longitude"] = lng or ""
            if i < len(new_items) - 1:
                time.sleep(COORD_DELAY_SEC)
        else:
            item["latitude"] = ""
            item["longitude"] = ""

        item["status"] = "有効" if item.get("latitude") else ""
        item["fetched_at"] = now_str

    # CSV書き込み（追記）
    file_exists = os.path.exists(OUT_CSV)
    os.makedirs(os.path.dirname(OUT_CSV), exist_ok=True)

    with open(OUT_CSV, "a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        if not file_exists:
            writer.writeheader()
        for item in new_items:
            writer.writerow({col: item.get(col, "") for col in CSV_COLUMNS})

    print(f"完了: {len(new_items)}件を追加 → {OUT_CSV}")


if __name__ == "__main__":
    main()
