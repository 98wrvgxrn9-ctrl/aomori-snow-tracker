#!/usr/bin/env python3
"""青森市営バス運行状況を取得して bus_status.json を更新する"""

import json
import os
import re
import urllib.request
from html.parser import HTMLParser

from sanitize_text import clean_record

BASE_URL = "https://aomori100.shizentai.jp/oshirase"
FETCH_TXT = f"{BASE_URL}/fetch.txt"
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "bus_status.json")
STATE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "bus_state.json")


class LineBreakHTMLParser(HTMLParser):
    """主要なブロック要素や <br> を改行として扱い、可読な行リストを作る"""

    BLOCK_TAGS = {
        "br", "p", "div", "li", "tr", "td", "th",
        "h1", "h2", "h3", "h4", "h5", "h6",
        "section", "article", "header", "footer", "hr",
    }

    def __init__(self):
        super().__init__()
        self.parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        if t in {"script", "style"}:
            self._skip_depth += 1
            return
        if self._skip_depth == 0 and t in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        t = tag.lower()
        if t in {"script", "style"} and self._skip_depth > 0:
            self._skip_depth -= 1
            return
        if self._skip_depth == 0 and t in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0:
            self.parts.append(data)

    def get_lines(self):
        text = "".join(self.parts)
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        lines = []
        for raw in text.split("\n"):
            line = re.sub(r"[ \t\u3000]+", " ", raw).strip()
            if line and line != "画像をタップ":
                lines.append(line)
        return lines


def fetch_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as res:
        body = res.read()
        charset = res.headers.get_content_charset() or "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def get_timestamp():
    """fetch.txt からタイムスタンプを取得"""
    txt = fetch_url(FETCH_TXT).strip()
    m = re.search(r"\b(\d{8}-\d{6})\b", txt)
    if not m:
        raise ValueError(f"fetch.txt の形式が不正です: {txt!r}")
    return m.group(1)


def html_to_lines(html):
    parser = LineBreakHTMLParser()
    parser.feed(html)
    return parser.get_lines()


def parse_route_line(route_text):
    """'小柳団地線 区間運休...' のような行から路線名と詳細先頭を分解"""
    text = route_text.strip()

    # 路線名は高確率で「〜線」で終わるため優先分解
    m = re.match(r"^(.+?線)(?:\s+(.*))?$", text)
    if m:
        return m.group(1).strip(), (m.group(2) or "").strip()

    parts = re.split(r"\s+", text, maxsplit=1)
    route_name = parts[0].strip()
    first_detail = parts[1].strip() if len(parts) > 1 else ""
    return route_name, first_detail


def classify_route_type(detail):
    if "区間運休" in detail and "迂回" in detail:
        return "区間運休・迂回"
    if "区間運休" in detail:
        return "区間運休"
    if "迂回" in detail:
        return "迂回"
    return None


def is_boundary_line(line):
    return (
        line.startswith("〇")
        or line.startswith("【")
        or line.startswith("※")
        or "TEL" in line
    )


def parse_bus_html(html):
    """バス運行状況HTMLをパースしてdict化"""
    # ラッパーページを誤って解析対象にした場合を検出
    if "idFrame.src" in html and "fetch('./fetch.txt')" in html:
        raise ValueError("ラッパーページを受信しました（timestamp付きURLの取得に失敗）")

    lines = html_to_lines(html)

    result = {
        "source": "青森市営バス運行状況お知らせ",
        "updated_at": None,
        "next_update_notice": None,
        "new_info": [],
        "resumed": [],
        "continuing": [],
        "notes": [],
        "contacts": [],
    }

    section = None  # new_info / resumed / continuing
    i = 0

    while i < len(lines):
        line = lines[i]

        # 更新準備中セクション
        if "更新準備中" in line:
            date_match = re.search(r"令和(\d+)年(\d+)月(\d+)日", line)
            date_str = ""
            if date_match:
                y = int(date_match.group(1)) + 2018
                m = int(date_match.group(2))
                d = int(date_match.group(3))
                date_str = f"{y}-{m:02d}-{d:02d}"

            msg_parts = []
            j = i + 1
            while j < len(lines):
                nl = lines[j]
                if "現在" in nl or nl.startswith("【") or nl.startswith("〇"):
                    break
                msg_parts.append(nl)
                j += 1

            result["next_update_notice"] = {
                "date": date_str,
                "status": "更新準備中",
                "message": "".join(msg_parts).strip(),
            }
            i = j
            continue

        # 確定更新日時
        time_match = re.search(r"令和(\d+)年(\d+)月(\d+)日.*?(\d+)時(\d+)分現在", line)
        if time_match:
            y = int(time_match.group(1)) + 2018
            m = int(time_match.group(2))
            d = int(time_match.group(3))
            h = int(time_match.group(4))
            mi = int(time_match.group(5))
            result["updated_at"] = f"{y}-{m:02d}-{d:02d} {h:02d}:{mi:02d}"
            i += 1
            continue

        # セクション見出し
        if "【新着情報】" in line or line.startswith("【新着"):
            section = "new_info"
            i += 1
            continue
        if "【運休を解除" in line or "【運休解除" in line or "通常運行" in line:
            section = "resumed"
            i += 1
            continue
        if "【運休・迂回運行を継続" in line or line.startswith("【継続"):
            section = "continuing"
            i += 1
            continue

        # 路線情報
        if line.startswith("〇"):
            route_text = line[1:].strip()
            route_name, first_detail = parse_route_line(route_text)
            detail_parts = [first_detail] if first_detail else []

            j = i + 1
            while j < len(lines):
                nl = lines[j]
                if is_boundary_line(nl):
                    break
                detail_parts.append(nl)
                j += 1

            detail = "".join(p for p in detail_parts if p).strip()
            entry = {"route": route_name, "detail": detail}

            route_type = classify_route_type(detail)
            if route_type:
                entry["type"] = route_type

            if section == "resumed":
                # 解除セクションで detail が空なら通常運行を補う
                if not entry["detail"]:
                    entry["detail"] = "（通常運行）"
                elif "通常運行" not in entry["detail"] and "type" not in entry:
                    entry["detail"] += "（通常運行）"
                result["resumed"].append(entry)
            elif section == "continuing":
                result["continuing"].append(entry)
            else:
                # new_info またはセクション不明
                result["new_info"].append(entry)

            i = j
            continue

        # 注意事項
        if line.startswith("※"):
            note = line[1:].strip()
            j = i + 1
            while j < len(lines):
                nl = lines[j]
                if is_boundary_line(nl):
                    break
                note += nl
                j += 1
            if note:
                result["notes"].append(note)
            i = j
            continue

        # 問い合わせ
        tel_match = re.search(r"(.+?)(?:\s+)TEL(?:\s+)?(\d[\d-]+)", line)
        if tel_match:
            result["contacts"].append({
                "name": tel_match.group(1).strip(),
                "tel": tel_match.group(2).strip(),
            })
            i += 1
            continue

        i += 1

    return result


def has_meaningful_content(data):
    return any([
        data.get("updated_at"),
        data.get("next_update_notice"),
        data.get("new_info"),
        data.get("resumed"),
        data.get("continuing"),
        data.get("notes"),
    ])


def main():
    try:
        ts = get_timestamp()
    except Exception as e:
        print(f"タイムスタンプ取得失敗: {e}")
        return

    print(f"タイムスタンプ: {ts}")

    prev_ts = None
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            state = json.load(f)
            prev_ts = state.get("timestamp")

    if ts == prev_ts:
        print("前回と同じタイムスタンプ。更新なし。")
        return

    url = f"{BASE_URL}/{ts}/oshirase.html"
    print(f"取得中: {url}")

    try:
        html = fetch_url(url)
        data = clean_record(parse_bus_html(html))
    except Exception as e:
        print(f"取得または解析に失敗: {e}")
        return

    if not has_meaningful_content(data):
        print("解析結果が空のため、既存データを保持します。")
        return

    print(f"更新日時: {data['updated_at']}")
    print(f"新着: {len(data['new_info'])}件, 解除: {len(data['resumed'])}件, 継続: {len(data['continuing'])}件")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"保存: {OUT_PATH}")

    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({"timestamp": ts}, f)
    print(f"状態保存: {STATE_PATH}")


if __name__ == "__main__":
    main()
