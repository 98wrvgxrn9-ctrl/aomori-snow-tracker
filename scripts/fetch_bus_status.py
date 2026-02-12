#!/usr/bin/env python3
"""青森市営バス運行状況を取得して bus_status.json を更新する"""

import json
import os
import re
import hashlib
import urllib.request
from html.parser import HTMLParser

BASE_URL = "https://aomori100.shizentai.jp/oshirase"
FETCH_TXT = f"{BASE_URL}/fetch.txt"
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "bus_status.json")
STATE_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "bus_state.json")


def fetch_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", errors="replace")


def get_timestamp():
    """fetch.txt からタイムスタンプを取得"""
    return fetch_url(FETCH_TXT).strip()


def strip_tags(html):
    """HTMLタグを除去してテキストだけ返す"""
    class TagStripper(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts = []
        def handle_data(self, d):
            self.parts.append(d)
        def get_text(self):
            return "".join(self.parts)
    s = TagStripper()
    s.feed(html)
    return s.get_text()


def parse_bus_html(html):
    """バス運行状況HTMLをパースしてdict化"""
    text = strip_tags(html)
    # 改行を統一
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    # 画像キャプション等を除去
    lines = [l for l in lines if l not in ("画像をタップ", "")]

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

    # 日付を抽出: "令和X年M月D日（曜日）　HH時MM分現在" or "更新準備中"
    section = None  # current section: new_info, resumed, continuing
    current_route = None
    i = 0
    while i < len(lines):
        line = lines[i]

        # 更新準備中セクション
        if "更新準備中" in line:
            # 日付を抽出
            date_match = re.search(r"令和(\d+)年(\d+)月(\d+)日", line)
            date_str = ""
            if date_match:
                y = int(date_match.group(1)) + 2018
                m = date_match.group(2)
                d = date_match.group(3)
                date_str = f"{y}-{int(m):02d}-{int(d):02d}"
            # 次の行にメッセージがある
            msg_parts = []
            j = i + 1
            while j < len(lines):
                nl = lines[j]
                if "現在" in nl or "【" in nl or nl.startswith("〇"):
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
        if "【新着情報】" in line or "【新着" in line:
            section = "new_info"
            # 見出し行に追加テキストがあれば備考的に無視（「道路狭隘…」等の前置き文）
            i += 1
            # 次の行が路線名でなければスキップ（前置き説明文）
            if i < len(lines) and not lines[i].startswith("〇"):
                i += 1  # 前置き文をスキップ
            continue
        elif "【運休を解除" in line or "【運休解除" in line or "通常運行" in line:
            section = "resumed"
            i += 1
            continue
        elif "【運休・迂回運行を継続" in line or "【継続" in line:
            section = "continuing"
            i += 1
            continue

        # 路線情報 "〇路線名..."
        if line.startswith("〇"):
            route_text = line[1:].strip()
            # 路線名と詳細を分離
            # パターン: "路線名　区間..." or "路線名\n詳細"
            parts = re.split(r"[　\t]", route_text, maxsplit=1)
            route_name = parts[0].strip()
            detail_parts = [parts[1].strip()] if len(parts) > 1 else []

            # 次の行が〇や【で始まらなければ詳細の続き
            j = i + 1
            while j < len(lines):
                nl = lines[j]
                if nl.startswith("〇") or nl.startswith("【") or nl.startswith("※") or "TEL" in nl:
                    break
                if nl == "画像をタップ":
                    j += 1
                    continue
                detail_parts.append(nl)
                j += 1

            detail = "".join(detail_parts).strip()
            # 括弧内の迂回情報を整理
            detail = detail.replace("（", "。（").replace("。。", "。").lstrip("。")

            entry = {"route": route_name, "detail": detail}

            # タイプ推定
            route_type = None
            if "区間運休" in detail and "迂回" in detail:
                route_type = "区間運休・迂回"
            elif "区間運休" in detail:
                route_type = "区間運休"
            elif "迂回" in detail:
                route_type = "迂回"
            elif "通常運行" in detail or section == "resumed":
                pass  # resumed にはtype不要

            if route_type:
                entry["type"] = route_type

            if section == "new_info":
                result["new_info"].append(entry)
            elif section == "resumed":
                # resumed は detail に "(通常運行)" を付ける
                if detail and "通常運行" not in detail:
                    entry["detail"] = detail + "（通常運行）"
                elif not detail:
                    entry["detail"] = "（通常運行）"
                result["resumed"].append(entry)
            elif section == "continuing":
                result["continuing"].append(entry)
            else:
                # セクション不明なら new_info に
                result["new_info"].append(entry)

            i = j
            continue

        # ※注意事項
        if line.startswith("※"):
            note = line[1:].strip()
            # 次の行も※や〇や【でなければ続き
            j = i + 1
            while j < len(lines):
                nl = lines[j]
                if nl.startswith("〇") or nl.startswith("【") or nl.startswith("※") or "TEL" in nl:
                    break
                note += nl
                j += 1

            # ※の後に路線情報（〇）が続くケースは別処理
            if "〇" in note:
                # ※の説明部分と〇路線部分を分離
                note_parts = note.split("〇", 1)
                result["notes"].append(note_parts[0].strip())
                # 〇以降は再処理のためiを戻す
                i = i  # 次のイテレーションで〇行を処理
                # 実際にはnote内の〇を処理する必要がある
                # テキストを lines に挿入
                remaining = "〇" + note_parts[1]
                lines.insert(i + 1, remaining)
                i += 1
                continue
            else:
                result["notes"].append(note)
                i = j
                continue

        # 連絡先
        tel_match = re.search(r"(.+?)(?:　| )+TEL(?:　| )+(\d[\d-]+)", line)
        if tel_match:
            result["contacts"].append({
                "name": tel_match.group(1).strip(),
                "tel": tel_match.group(2).strip(),
            })
            i += 1
            continue

        i += 1

    return result


def main():
    # タイムスタンプ取得
    ts = get_timestamp()
    print(f"タイムスタンプ: {ts}")

    # 前回の状態と比較
    prev_ts = None
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, "r") as f:
            state = json.load(f)
            prev_ts = state.get("timestamp")

    if ts == prev_ts:
        print("前回と同じタイムスタンプ。更新なし。")
        return

    # お知らせHTML取得
    url = f"{BASE_URL}/{ts}/oshirase.html"
    print(f"取得中: {url}")
    html = fetch_url(url)

    # パース
    data = parse_bus_html(html)
    print(f"更新日時: {data['updated_at']}")
    print(f"新着: {len(data['new_info'])}件, 解除: {len(data['resumed'])}件, 継続: {len(data['continuing'])}件")

    # JSON出力
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"保存: {OUT_PATH}")

    # 状態保存
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump({"timestamp": ts}, f)
    print(f"状態保存: {STATE_PATH}")


if __name__ == "__main__":
    main()
