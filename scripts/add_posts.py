#!/usr/bin/env python3
"""
data/urls.txt に貼られたXのURLから投稿を取得し、
OpenAIでエリア推定して docs/data/x_posts.json に追加するスクリプト。

使い方:
  1. data/urls.txt にXのURLを1行ずつ貼る
  2. python3 scripts/add_posts.py を実行
  3. 処理済みURLは data/urls_done.txt に移動される
"""

import json
import os
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

# ファイルパス
BASE_DIR = os.path.join(os.path.dirname(__file__), "..")
URLS_FILE = os.path.join(BASE_DIR, "data", "urls.txt")
DONE_FILE = os.path.join(BASE_DIR, "data", "urls_done.txt")
POSTS_FILE = os.path.join(BASE_DIR, "docs", "data", "x_posts.json")
AREAS_META_FILE = os.path.join(BASE_DIR, "docs", "data", "areas_meta.json")
ENV_FILE = os.path.join(BASE_DIR, ".env")


def load_env():
    """ローカル.envから環境変数を読み込み"""
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())


def extract_tweet_id(url):
    """URLからツイートIDを抽出"""
    m = re.search(r"/status/(\d+)", url)
    return m.group(1) if m else None


def fetch_tweet(tweet_id):
    """X APIで1件のツイートを取得（$0.005）"""
    bearer = os.environ.get("X_BEARER_TOKEN", "")
    if not bearer:
        print("  X_BEARER_TOKEN が設定されていません")
        return None

    url = f"https://api.twitter.com/2/tweets/{tweet_id}"
    params = "?tweet.fields=created_at,author_id,attachments&expansions=author_id,attachments.media_keys&media.fields=url,preview_image_url&user.fields=username"

    req = urllib.request.Request(url + params)
    req.add_header("Authorization", f"Bearer {bearer}")

    try:
        resp = urllib.request.urlopen(req)
        return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  API Error ({e.code}): {e.read().decode()}")
        return None


def infer_area(text):
    """OpenAIでエリアを推定（$0.001程度）"""
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        print("  OPENAI_API_KEY が設定されていません。エリア空欄で追加します。")
        return ""

    # エリア名リスト読み込み
    area_names = []
    if os.path.exists(AREAS_META_FILE):
        with open(AREAS_META_FILE) as f:
            meta = json.load(f)
            area_names = list(meta.get("areas", {}).keys())

    prompt = f"""以下のX投稿が青森市のどのエリアに関するものか判定してください。
エリア名リスト: {', '.join(area_names[:50])}...

投稿: {text}

該当するエリア名を1つだけ返してください。該当なしなら空文字を返してください。エリア名のみ出力。"""

    payload = json.dumps({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 50,
        "temperature": 0,
    }).encode()

    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=payload)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")

    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read().decode())
        area = result["choices"][0]["message"]["content"].strip()
        # エリアリストに存在するか確認
        if area and area in area_names:
            return area
        # 部分一致
        for name in area_names:
            if area and area in name:
                return name
        return ""
    except Exception as e:
        print(f"  OpenAI Error: {e}")
        return ""


def load_posts():
    """既存の投稿データを読み込み"""
    if os.path.exists(POSTS_FILE):
        with open(POSTS_FILE) as f:
            return json.load(f)
    return {"updated": "", "posts": []}


def save_posts(data):
    """投稿データを保存"""
    data["updated"] = datetime.now(JST).isoformat()
    with open(POSTS_FILE, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main():
    load_env()

    # urls.txt 読み込み
    if not os.path.exists(URLS_FILE):
        print(f"{URLS_FILE} が見つかりません。URLを1行ずつ書いてください。")
        return

    with open(URLS_FILE) as f:
        urls = [line.strip() for line in f if line.strip()]

    if not urls:
        print("処理するURLがありません。")
        return

    print(f"{len(urls)}件のURLを処理します。\n")

    posts_data = load_posts()
    existing_ids = {p["id"] for p in posts_data["posts"]}
    done_urls = []
    added = 0

    for url in urls:
        tweet_id = extract_tweet_id(url)
        if not tweet_id:
            print(f"スキップ（ID抽出不可）: {url}")
            done_urls.append(url)
            continue

        if tweet_id in existing_ids:
            print(f"スキップ（登録済み）: {tweet_id}")
            done_urls.append(url)
            continue

        print(f"取得中: {tweet_id}")
        result = fetch_tweet(tweet_id)
        if not result or "data" not in result:
            print(f"  取得失敗")
            continue

        tweet = result["data"]
        text = tweet.get("text", "")

        # ユーザー名取得
        author = tweet.get("author_id", "")
        users = {u["id"]: u for u in result.get("includes", {}).get("users", [])}
        if author in users:
            author = f"@{users[author]['username']}"

        # 画像URL取得
        image_url = ""
        media_map = {m["media_key"]: m for m in result.get("includes", {}).get("media", [])}
        if tweet.get("attachments", {}).get("media_keys"):
            mk = tweet["attachments"]["media_keys"][0]
            if mk in media_map:
                image_url = media_map[mk].get("url", "") or media_map[mk].get("preview_image_url", "")

        # 投稿日時
        created = tweet.get("created_at", "")
        if created:
            dt = datetime.fromisoformat(created.replace("Z", "+00:00")).astimezone(JST)
            posted_at = dt.strftime("%Y-%m-%d %H:%M")
        else:
            posted_at = ""

        # エリア推定
        print(f"  エリア推定中...")
        area = infer_area(text)
        print(f"  エリア: {area or '(不明)'}")

        # 投稿追加
        post = {
            "id": tweet_id,
            "url": url,
            "text": text,
            "author": author,
            "posted_at": posted_at,
            "area": area,
            "image_url": image_url,
        }
        posts_data["posts"].insert(0, post)
        existing_ids.add(tweet_id)
        done_urls.append(url)
        added += 1
        print(f"  追加完了\n")

    # 保存
    save_posts(posts_data)
    print(f"\n{added}件追加しました。合計{len(posts_data['posts'])}件。")

    # 処理済みURLを移動
    with open(DONE_FILE, "a") as f:
        for url in done_urls:
            f.write(url + "\n")

    # urls.txt をクリア
    remaining = [u for u in urls if u not in done_urls]
    with open(URLS_FILE, "w") as f:
        for u in remaining:
            f.write(u + "\n")

    cost = added * 0.006
    print(f"推定コスト: ${cost:.3f}")


if __name__ == "__main__":
    main()
