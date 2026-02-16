#!/usr/bin/env python3
"""
除排雪スケジュール更新を @aomori_snowatch に自動投稿するスクリプト。
GitHub Actionsから fetch_kml.py の後に実行される。
GeoJSONの差分を検出し、変更があった場合のみ投稿する。
"""

import json
import os
import hashlib
import hmac
import base64
import time
import uuid
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

# 投稿先URL
TWEET_URL = "https://api.twitter.com/2/tweets"

# 状態ファイル（前回のGeoJSONハッシュを記録）
STATE_FILE = "data/x_post_state.json"

# GeoJSONファイル
GEOJSON_FILES = [
    "docs/data/koku.geojson",
    "docs/data/rosen.geojson",
]


def load_env():
    """環境変数またはローカル.envからAPIキーを取得"""
    # ローカル実行時は.envを読む
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())

    return {
        "api_key": os.environ.get("X_API_KEY", ""),
        "api_secret": os.environ.get("X_API_SECRET", ""),
        "access_token": os.environ.get("X_ACCESS_TOKEN", ""),
        "access_token_secret": os.environ.get("X_ACCESS_TOKEN_SECRET", ""),
    }


def oauth_sign(method, url, params, consumer_secret, token_secret):
    """OAuth 1.0a HMAC-SHA1 署名"""
    base = (
        method.upper()
        + "&"
        + urllib.parse.quote(url, safe="")
        + "&"
        + urllib.parse.quote(
            urllib.parse.urlencode(sorted(params.items())), safe=""
        )
    )
    key = (
        urllib.parse.quote(consumer_secret, safe="")
        + "&"
        + urllib.parse.quote(token_secret, safe="")
    )
    # OAuth 1.0a仕様でHMAC-SHA1が必須（アルゴリズム変更不可）
    sig = base64.b64encode(
        hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()  # nosec
    ).decode()
    return sig


def post_tweet(text, keys):
    """ツイートを投稿"""
    oauth_params = {
        "oauth_consumer_key": keys["api_key"],
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": keys["access_token"],
        "oauth_version": "1.0",
    }
    sig = oauth_sign(
        "POST", TWEET_URL, oauth_params, keys["api_secret"], keys["access_token_secret"]
    )
    oauth_params["oauth_signature"] = sig

    auth_header = "OAuth " + ", ".join(
        f'{urllib.parse.quote(k, safe="")}="{urllib.parse.quote(v, safe="")}"'
        for k, v in sorted(oauth_params.items())
    )

    payload = json.dumps({"text": text}).encode()
    req = urllib.request.Request(TWEET_URL, data=payload, method="POST")
    req.add_header("Authorization", auth_header)
    req.add_header("Content-Type", "application/json")

    try:
        resp = urllib.request.urlopen(req)
        result = json.loads(resp.read().decode())
        print(f"投稿成功: {result['data']['id']}")
        return True
    except urllib.error.HTTPError as e:
        print(f"投稿失敗 ({e.code}): {e.read().decode()}")
        return False


def compute_hash():
    """GeoJSONファイルの内容ハッシュを計算"""
    h = hashlib.sha256()
    for path in GEOJSON_FILES:
        if os.path.exists(path):
            with open(path, "rb") as f:
                h.update(f.read())
    return h.hexdigest()


def load_state():
    """前回の状態を読み込み"""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}


def save_state(state):
    """状態を保存"""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def build_tweet_text():
    """GeoJSONからツイート本文を生成"""
    now = datetime.now(JST)
    date_str = now.strftime("%m/%d %H:%M")

    # 工区GeoJSONからステータス集計
    counts = {"scheduled": 0, "checking": 0, "adjusting": 0}
    areas_scheduled = []

    for path in GEOJSON_FILES:
        if not os.path.exists(path):
            continue
        with open(path) as f:
            data = json.load(f)
        for feat in data.get("features", []):
            status = feat.get("properties", {}).get("ステータス", "")
            name = feat.get("properties", {}).get("名前", "")
            if "作業予定あり" in status or "作業中" in status:
                counts["scheduled"] += 1
                date = feat.get("properties", {}).get("直近作業予定日", "")
                if date:
                    areas_scheduled.append(f"{name}({date})")
            elif "現場確認中" in status:
                counts["checking"] += 1
            elif "作業日程調整中" in status:
                counts["adjusting"] += 1

    total = counts["scheduled"] + counts["checking"] + counts["adjusting"]

    text = f"【{date_str}更新】青森市 除排雪状況\n"
    text += f"予定あり {counts['scheduled']} / 確認中 {counts['checking']} / 調整中 {counts['adjusting']}\n"

    # 作業予定ありのエリアを数件表示
    if areas_scheduled:
        shown = [a.split("(")[0] for a in areas_scheduled[:3]]
        text += "▶ " + "・".join(shown)
        if len(areas_scheduled) > 3:
            text += f" 他{len(areas_scheduled) - 3}件"
        text += "\n"

    text += "#青森市 #除雪 #青森除雪ウォッチ"

    # X文字数制限: 全角=2, 半角=1, 改行=1 で280以内
    def x_len(s):
        count = 0
        for c in s:
            count += 2 if ord(c) > 127 else 1
        return count

    while x_len(text) > 280:
        text = text[:len(text) - 5] + "..."

    return text


def main():
    keys = load_env()
    if not keys["api_key"] or not keys["access_token"]:
        print("APIキーが設定されていません。スキップします。")
        return

    current_hash = compute_hash()
    state = load_state()
    prev_hash = state.get("last_hash", "")

    if current_hash == prev_hash:
        print("GeoJSONに変更なし。投稿をスキップします。")
        return

    text = build_tweet_text()
    print(f"投稿内容:\n{text}\n")

    success = post_tweet(text, keys)
    if success:
        state["last_hash"] = current_hash
        state["last_posted"] = datetime.now(JST).isoformat()
        save_state(state)


if __name__ == "__main__":
    main()
