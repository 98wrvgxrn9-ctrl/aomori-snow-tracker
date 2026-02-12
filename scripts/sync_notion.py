#!/usr/bin/env python3
"""
青森市除排雪データをNotionデータベースに同期するスクリプト
fetch_kml.py の実行後に呼び出される想定
"""

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta

import requests

NOTION_API_KEY = os.environ.get("NOTION_API_KEY", "")
PARENT_PAGE_ID = "2aeffdc55ca080b688b5c8ae92f5a29e"
NOTION_VERSION = "2022-06-28"
NOTION_BASE = "https://api.notion.com/v1"

JST = timezone(timedelta(hours=9))

HEADERS = {
    "Authorization": f"Bearer {NOTION_API_KEY}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
}

# DB IDを保存するファイル（初回作成後に記録）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_IDS_FILE = os.path.join(SCRIPT_DIR, "..", "data", "notion_db_ids.json")


def load_db_ids():
    if os.path.exists(DB_IDS_FILE):
        with open(DB_IDS_FILE, "r") as f:
            return json.load(f)
    return {}


def save_db_ids(ids):
    with open(DB_IDS_FILE, "w") as f:
        json.dump(ids, f, indent=2)


def notion_request(method, endpoint, payload=None, retries=3):
    url = f"{NOTION_BASE}{endpoint}"
    for attempt in range(retries):
        resp = requests.request(method, url, headers=HEADERS, json=payload, timeout=30)
        if resp.status_code == 429 or resp.status_code >= 500:
            wait = (attempt + 1) * 2
            print(f"  リトライ({resp.status_code})... {wait}秒待機")
            time.sleep(wait)
            continue
        if resp.status_code >= 400:
            print(f"Notion API error: {resp.status_code} {resp.text}")
        resp.raise_for_status()
        return resp.json()
    resp.raise_for_status()
    return resp.json()


def create_database(parent_page_id, title, properties):
    """Notionデータベースを作成"""
    payload = {
        "parent": {"type": "page_id", "page_id": parent_page_id},
        "title": [{"type": "text", "text": {"content": title}}],
        "properties": properties,
    }
    result = notion_request("POST", "/databases", payload)
    print(f"DB作成: {title} (ID: {result['id']})")
    return result["id"]


def get_koku_db_properties():
    return {
        "工区名": {"title": {}},
        "ステータス": {"select": {}},
        "直近作業予定日": {"rich_text": {}},
        "指令": {"select": {}},
        "更新日時": {"rich_text": {}},
        "お知らせ": {"rich_text": {}},
    }


def get_rosen_db_properties():
    return {
        "路線名": {"title": {}},
        "ステータス": {"select": {}},
        "直近作業予定日": {"rich_text": {}},
        "指令": {"select": {}},
        "更新日時": {"rich_text": {}},
        "お知らせ": {"rich_text": {}},
    }


def get_history_db_properties():
    return {
        "名前": {"title": {}},
        "取得日時": {"rich_text": {}},
        "種別": {"select": {}},
        "ステータス": {"select": {}},
        "直近作業予定日": {"rich_text": {}},
        "指令": {"rich_text": {}},
    }


def query_all_pages(database_id):
    """DB内の全ページを取得"""
    pages = []
    payload = {"page_size": 100}
    while True:
        result = notion_request("POST", f"/databases/{database_id}/query", payload)
        pages.extend(result["results"])
        if not result.get("has_more"):
            break
        payload["start_cursor"] = result["next_cursor"]
    return pages


def get_title_value(page):
    """ページのtitleプロパティの値を取得"""
    for prop in page["properties"].values():
        if prop["type"] == "title":
            if prop["title"]:
                return prop["title"][0]["plain_text"]
    return ""


def make_rich_text(value):
    if not value:
        return []
    return [{"type": "text", "text": {"content": str(value)}}]


def make_select(value):
    if not value:
        return None
    return {"name": str(value)}


def sync_current_data(database_id, data, title_key):
    """工区/路線DBにデータを同期（upsert）"""
    existing = query_all_pages(database_id)
    existing_map = {}
    for page in existing:
        name = get_title_value(page)
        if name:
            existing_map[name] = page["id"]

    created = 0
    updated = 0

    for row in data:
        name = row.get("名前", "")
        if not name:
            continue

        status = row.get("ステータス", "")
        # ステータスを短縮表記にする
        if "作業予定あり" in status:
            status = "作業予定あり"
        elif "作業日程調整中" in status:
            status = "作業日程調整中"
        elif "現場確認中" in status:
            status = "現場確認中"
        elif "作業中" in status:
            status = "作業中"

        properties = {
            title_key: {"title": make_rich_text(name)},
            "ステータス": {"select": make_select(status)},
            "直近作業予定日": {"rich_text": make_rich_text(row.get("直近作業予定日", ""))},
            "指令": {"select": make_select(row.get("指令", ""))},
            "更新日時": {"rich_text": make_rich_text(row.get("更新日時", ""))},
            "お知らせ": {"rich_text": make_rich_text(row.get("お知らせ", ""))},
        }

        if name in existing_map:
            # 更新
            page_id = existing_map[name]
            notion_request("PATCH", f"/pages/{page_id}", {"properties": properties})
            updated += 1
        else:
            # 新規作成
            payload = {
                "parent": {"database_id": database_id},
                "properties": properties,
            }
            notion_request("POST", "/pages", payload)
            created += 1
        time.sleep(0.35)

    print(f"  新規: {created}件, 更新: {updated}件")


def sync_history(database_id, data, kind, prev_data):
    """ステータスが変化した項目のみ履歴DBに追記"""
    timestamp = datetime.now(JST).strftime("%Y-%m-%d %H:%M")

    prev_map = {}
    for row in prev_data:
        prev_map[row.get("名前", "")] = row.get("ステータス", "")

    added = 0
    for row in data:
        name = row.get("名前", "")
        status = row.get("ステータス", "")
        prev_status = prev_map.get(name, "")

        if status != prev_status:
            properties = {
                "名前": {"title": make_rich_text(name)},
                "取得日時": {"rich_text": make_rich_text(timestamp)},
                "種別": {"select": make_select(kind)},
                "ステータス": {"select": make_select(status)},
                "直近作業予定日": {"rich_text": make_rich_text(row.get("直近作業予定日", ""))},
                "指令": {"rich_text": make_rich_text(row.get("指令", ""))},
            }
            payload = {
                "parent": {"database_id": database_id},
                "properties": properties,
            }
            notion_request("POST", "/pages", payload)
            added += 1

    print(f"  履歴追記: {added}件")


def load_latest_json(data_dir, prefix):
    """最新のJSONスナップショットを読み込み"""
    files = sorted(
        [f for f in os.listdir(data_dir) if f.startswith(prefix) and f.endswith(".json")],
        reverse=True,
    )
    if not files:
        return []
    filepath = os.path.join(data_dir, files[0])
    with open(filepath, "r", encoding="utf-8") as f:
        snapshot = json.load(f)
    return snapshot.get("data", [])


def load_previous_json(data_dir, prefix):
    """2番目に新しいJSONスナップショットを読み込み（前回分）"""
    files = sorted(
        [f for f in os.listdir(data_dir) if f.startswith(prefix) and f.endswith(".json")],
        reverse=True,
    )
    if len(files) < 2:
        return []
    filepath = os.path.join(data_dir, files[1])
    with open(filepath, "r", encoding="utf-8") as f:
        snapshot = json.load(f)
    return snapshot.get("data", [])


def main():
    if not NOTION_API_KEY:
        print("NOTION_API_KEY環境変数が設定されていません。")
        sys.exit(1)

    data_dir = os.path.join(SCRIPT_DIR, "..", "data")
    db_ids = load_db_ids()

    # DB作成（初回のみ）
    if "koku" not in db_ids:
        db_ids["koku"] = create_database(
            PARENT_PAGE_ID, "除排雪状況（工区）", get_koku_db_properties()
        )
    if "rosen" not in db_ids:
        db_ids["rosen"] = create_database(
            PARENT_PAGE_ID, "除排雪状況（路線）", get_rosen_db_properties()
        )
    if "history" not in db_ids:
        db_ids["history"] = create_database(
            PARENT_PAGE_ID, "除排雪履歴", get_history_db_properties()
        )
    save_db_ids(db_ids)

    # 最新データ読み込み
    koku_data = load_latest_json(data_dir, "koku_")
    rosen_data = load_latest_json(data_dir, "rosen_")

    # 前回データ読み込み（履歴差分用）
    koku_prev = load_previous_json(data_dir, "koku_")
    rosen_prev = load_previous_json(data_dir, "rosen_")

    # 工区同期
    print("工区データを同期中...")
    sync_current_data(db_ids["koku"], koku_data, "工区名")

    # 路線同期
    print("路線データを同期中...")
    sync_current_data(db_ids["rosen"], rosen_data, "路線名")

    # 履歴同期
    print("履歴データを同期中...")
    sync_history(db_ids["history"], koku_data, "工区", koku_prev)
    sync_history(db_ids["history"], rosen_data, "路線", rosen_prev)

    print("Notion同期完了")


if __name__ == "__main__":
    main()
