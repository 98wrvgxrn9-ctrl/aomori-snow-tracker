#!/usr/bin/env python3
"""
X 投稿取得スクリプト（青森市除雪向け）
- 差分取得（since_id）
- 予算管理（投稿 + ユーザー課金）
- 愚痴だけ投稿をなるべく除外
- 画像URLの任意取得
- OpenAIによる行動可能性判定 + 地区推論（任意）
"""

import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError
import time

from dotenv import load_dotenv

# 課金設定（ユーザー提供単価）
COST_PER_TWEET = 0.005
COST_PER_USER = 0.01
BUDGET_LIMIT = 9.50

COST_LOG_FILE = "data/x_api_cost.json"
STATE_FILE = "data/x_api_state.json"
OUTPUT_FILE = "docs/data/x_posts.json"
MAX_RESULTS_PER_REQUEST = 50
SEARCH_QUERY = (
    "(青森 OR 青森市) (除雪 OR 排雪 OR 積雪 OR 路面 OR 轍 OR 歩道 OR スタック) "
    "-is:retweet lang:ja"
)

OPENAI_MODEL = "gpt-4o-mini"
JST = timezone(timedelta(hours=9))

AREA_HINTS = [
    r"[A-ZＡ-Ｚ]-?\d", r"[Ａ-Ｚ]－\d",
    # areas_meta.json住所から自動抽出した93地名
    r"けやき", r"はまなす", r"三内", r"三好", r"上林", r"中佃", r"中央",
    r"久栗坂", r"久須志", r"八ッ橋", r"八重田", r"前田", r"勝田", r"北金沢",
    r"千刈", r"千富町", r"南佃", r"原別", r"古川", r"古館", r"合浦", r"唐崎",
    r"問屋町", r"堤町", r"大矢沢", r"奥内", r"奥野", r"妙見", r"安方", r"安田",
    r"宮田", r"富田", r"小柳", r"山下", r"岡造道", r"左堰", r"常盤", r"平新田",
    r"幸畑", r"新城", r"新町", r"新町野", r"旭町", r"月見野", r"本泉", r"本町",
    r"東造道", r"松原", r"松森", r"柳川", r"桂木", r"桜川", r"橋本", r"沖館",
    r"沢山", r"油川", r"浅虫", r"浜田", r"浜館", r"浪打", r"浪館", r"浪館前田",
    r"港町", r"滝沢", r"片岡", r"玉川", r"矢作", r"矢田", r"矢田前", r"石江",
    r"第二問屋町", r"筒井", r"篠田", r"細越", r"羽白", r"自由ケ丘", r"花園",
    r"若宮", r"茶屋町", r"蛍沢", r"西大野", r"西滝", r"豊田", r"赤坂", r"造道",
    r"里見", r"野尻", r"金沢", r"長島", r"飛鳥", r"高田", r"鳴滝",
    # 工区名にある追加地名
    r"三本木", r"合子沢", r"荒川", r"戸山", r"横内", r"白旗野", r"野木",
    r"野内", r"金浜", r"下湯", r"後潟", r"内真部", r"大別内",
]
ROAD_HINTS = [
    r"除雪", r"排雪", r"轍", r"路面", r"すれ違", r"通れ", r"スタック", r"歩道", r"雪庇"
]
SEVERITY_HINTS = [
    r"来てない", r"来ない", r"危険", r"埋ま", r"孤島", r"出せない", r"通行不能",
    r"渋滞", r"ひどい", r"最悪", r"困って", r"助けて", r"早く"
]


def load_env():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(script_dir, "..", ".env")
    load_dotenv(env_path)
    bearer = os.getenv("X_BEARER_TOKEN")
    if not bearer:
        print("エラー: X_BEARER_TOKEN が設定されていません")
        sys.exit(1)
    return bearer, os.getenv("OPENAI_API_KEY")


def _load_json(path, default):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def _save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_cost_log(base_dir):
    return _load_json(
        os.path.join(base_dir, COST_LOG_FILE),
        {"total_cost": 0.0, "total_tweets": 0, "total_users": 0, "runs": []},
    )


def save_cost_log(base_dir, log):
    _save_json(os.path.join(base_dir, COST_LOG_FILE), log)


def load_state(base_dir):
    return _load_json(os.path.join(base_dir, STATE_FILE), {"since_id": None})


def save_state(base_dir, state):
    _save_json(os.path.join(base_dir, STATE_FILE), state)


def load_existing_posts(base_dir):
    return _load_json(os.path.join(base_dir, OUTPUT_FILE), {"updated": "", "posts": []})


def save_posts(base_dir, data):
    data["updated"] = datetime.now(JST).isoformat()
    _save_json(os.path.join(base_dir, OUTPUT_FILE), data)


def x_api_get(bearer_token, endpoint, params, timeout=20, retries=3):
    url = f"{endpoint}?{urlencode(params)}"
    req = Request(
        url,
        headers={
            "Authorization": f"Bearer {bearer_token}",
            "User-Agent": "aomori-snow-tracker/1.1",
        },
    )
    for i in range(retries):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            body = e.read().decode("utf-8") if e.fp else ""
            if e.code == 429 and i < retries - 1:
                wait = 30 * (i + 1)
                print(f"429 rate limit。{wait}秒待機して再試行")
                time.sleep(wait)
                continue
            print(f"X API エラー {e.code}: {body[:300]}")
            return None
        except URLError as e:
            if i < retries - 1:
                time.sleep(3 * (i + 1))
                continue
            print(f"X API 接続エラー: {e}")
            return None
    return None


def search_tweets(bearer_token, query, max_results, since_id=None):
    params = {
        "query": query,
        "max_results": max_results,
        "tweet.fields": "created_at,author_id,text,attachments",
        "expansions": "author_id,attachments.media_keys",
        "user.fields": "username",
        "media.fields": "url,preview_image_url,type",
    }
    if since_id:
        params["since_id"] = since_id
    return x_api_get(bearer_token, "https://api.x.com/2/tweets/search/recent", params)


def to_jst_str(created_at):
    if not created_at:
        return ""
    try:
        dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        return dt.astimezone(JST).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return created_at


def load_area_names(base_dir):
    """areas_meta.jsonから正式な工区/路線名の一覧とその住所を取得"""
    meta_path = os.path.join(base_dir, "docs", "data", "areas_meta.json")
    if not os.path.exists(meta_path):
        return {}
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    # name -> address のマッピング
    return {name: info.get("address", "") for name, info in meta.get("areas", {}).items()}


# 広域すぎて工区紐づけに使えないワード
BROAD_AREAS = {"青森市", "青森", "青森県", "青森市内", "市内", "弘前", "弘前市", ""}


def normalize_area(raw_area, area_names):
    """OpenAIが返したareaを工区マスタの正式名に正規化する。
    - 広域ワードは空文字に（「最新の声」行き）
    - 工区マスタに完全一致すればそのまま
    - 地名が工区マスタの住所に含まれていれば、その工区名に変換
    """
    if not raw_area or raw_area in BROAD_AREAS:
        return ""

    # 完全一致
    if raw_area in area_names:
        return raw_area

    # 部分一致: raw_areaが工区名に含まれる
    for name in area_names:
        if raw_area in name:
            return name

    # 住所マッチ: raw_areaが住所に含まれる工区を探す
    matches = []
    for name, address in area_names.items():
        if raw_area in address:
            matches.append(name)

    if len(matches) == 1:
        return matches[0]
    elif len(matches) > 1:
        # 複数マッチは最初の1件を返す（隣接伝播で他もカバーされる）
        return matches[0]

    # マッチなし → そのまま返す（「最新の声」に表示される）
    return raw_area


def passes_rule_filter(text):
    has_area = any(re.search(p, text) for p in AREA_HINTS)
    has_road = any(re.search(p, text) for p in ROAD_HINTS)
    has_severity = any(re.search(p, text) for p in SEVERITY_HINTS)
    # 厳しすぎる除外を避ける:
    # 1) 路面・除雪関連ワードがある
    # 2) 地名ヒント または 苦情強度語 のどちらかを満たす
    return has_road and (has_area or has_severity)


def infer_with_openai(api_key, text):
    if not api_key:
        return {"actionable": None, "area": "", "reason": ""}
    payload = {
        "model": OPENAI_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "あなたは青森市除雪投稿の分類器。JSONのみ返す。"
                    "形式: {\"actionable\":true/false,\"area\":\"推定地区や工区\",\"reason\":\"20字以内\"}"
                ),
            },
            {
                "role": "user",
                "content": f"投稿: {text}",
            },
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    req = Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=20) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            content = res["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            return {
                "actionable": parsed.get("actionable"),
                "area": parsed.get("area", ""),
                "reason": parsed.get("reason", ""),
            }
    except Exception:
        return {"actionable": None, "area": "", "reason": ""}


def main():
    bearer_token, openai_api_key = load_env()
    base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

    cost_log = load_cost_log(base_dir)
    state = load_state(base_dir)
    existing = load_existing_posts(base_dir)
    existing_ids = {p["id"] for p in existing["posts"]}
    area_names = load_area_names(base_dir)

    remaining = BUDGET_LIMIT - cost_log["total_cost"]
    if remaining <= 0:
        print(f"予算上限到達: ${cost_log['total_cost']:.3f} / ${BUDGET_LIMIT}")
        return

    print("=== X投稿取得 ===")
    print(f"累計コスト: ${cost_log['total_cost']:.3f} / ${BUDGET_LIMIT}")
    print(f"since_id: {state.get('since_id')}")

    result = search_tweets(
        bearer_token=bearer_token,
        query=SEARCH_QUERY,
        max_results=MAX_RESULTS_PER_REQUEST,
        since_id=state.get("since_id"),
    )
    if not result:
        print("検索に失敗しました。")
        return

    tweets = result.get("data", [])
    includes = result.get("includes", {})
    users_by_id = {u["id"]: u for u in includes.get("users", [])}
    media_by_key = {m["media_key"]: m for m in includes.get("media", [])}
    unique_users_count = len(users_by_id)

    run_cost = len(tweets) * COST_PER_TWEET + unique_users_count * COST_PER_USER
    if run_cost > remaining:
        print(f"今回取得見込みコスト ${run_cost:.3f} が残予算 ${remaining:.3f} を超えるため停止")
        return

    print(f"取得件数: {len(tweets)} (users={unique_users_count})")
    print(f"今回推定コスト: ${run_cost:.3f}")

    new_count = 0
    accepted_count = 0
    max_id = state.get("since_id")

    for tw in tweets:
        tw_id = tw["id"]
        if (max_id is None) or (int(tw_id) > int(max_id)):
            max_id = tw_id
        if tw_id in existing_ids:
            continue

        text = tw.get("text", "")
        if not passes_rule_filter(text):
            continue

        cls = infer_with_openai(openai_api_key, text)
        if cls["actionable"] is False:
            continue

        user = users_by_id.get(tw.get("author_id", ""), {})
        username = user.get("username", "")
        author = f"@{username}" if username else f"@{tw.get('author_id', '')}"

        image_url = ""
        for mk in tw.get("attachments", {}).get("media_keys", []):
            media = media_by_key.get(mk, {})
            if media.get("type") == "photo":
                image_url = media.get("url", "") or media.get("preview_image_url", "")
                if image_url:
                    break

        post = {
            "id": tw_id,
            "url": f"https://x.com/{username}/status/{tw_id}" if username else f"https://x.com/i/status/{tw_id}",
            "text": text,
            "author": author,
            "posted_at": to_jst_str(tw.get("created_at", "")),
            "area": normalize_area(cls["area"], area_names) if area_names else (cls["area"] or ""),
            "image_url": image_url,
        }
        existing["posts"].append(post)
        existing_ids.add(tw_id)
        new_count += 1
        accepted_count += 1

    existing["posts"] = sorted(existing["posts"], key=lambda x: x.get("posted_at", ""), reverse=True)
    save_posts(base_dir, existing)

    cost_log["total_cost"] += run_cost
    cost_log["total_tweets"] += len(tweets)
    cost_log["total_users"] += unique_users_count
    cost_log["runs"].append(
        {
            "timestamp": datetime.now(JST).isoformat(),
            "tweets_fetched": len(tweets),
            "users_fetched": unique_users_count,
            "accepted_posts": accepted_count,
            "new_posts": new_count,
            "cost": run_cost,
        }
    )
    save_cost_log(base_dir, cost_log)

    if max_id:
        state["since_id"] = str(max_id)
        save_state(base_dir, state)

    print(f"結果: 新規 {new_count} 件")
    print(f"累計コスト: ${cost_log['total_cost']:.3f} / ${BUDGET_LIMIT}")
    print(f"保存: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
