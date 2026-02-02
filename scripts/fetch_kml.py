#!/usr/bin/env python3
"""
青森市除排雪出動指令状況KML取得・解析スクリプト
"""

import csv
import json
import os
import zipfile
from datetime import datetime, timezone, timedelta
from io import BytesIO
from xml.etree import ElementTree as ET

import requests

# Google マイマップのKMLエクスポートURL
KML_URL = "https://www.google.com/maps/d/kml?mid=1Ydi7GSvJ_4zOLatVL_FOUMwoZdTN-_8"

# ステータスの色コード対応
STATUS_COLORS = {
    "#DB4436": "作業中",
    "#0288D1": "現場確認中",
    "#FFDD5E": "作業予定あり",
}

# 日本時間
JST = timezone(timedelta(hours=9))


def fetch_kml():
    """KMZ(ZIP)をダウンロードしてKMLを抽出"""
    response = requests.get(KML_URL, timeout=30)
    response.raise_for_status()

    with zipfile.ZipFile(BytesIO(response.content)) as zf:
        for name in zf.namelist():
            if name.endswith('.kml'):
                return zf.read(name).decode('utf-8')

    raise ValueError("KMLファイルが見つかりません")


def parse_kml(kml_content):
    """KMLを解析して工区ごとのステータスを抽出"""
    root = ET.fromstring(kml_content)

    # KML名前空間
    ns = {'kml': 'http://www.opengis.net/kml/2.2'}

    # スタイルID→色のマッピングを構築
    style_colors = {}
    for style in root.findall('.//kml:Style', ns):
        style_id = style.get('id', '')
        poly_style = style.find('.//kml:PolyStyle/kml:color', ns)
        if poly_style is not None:
            # KMLの色はAABBGGRR形式なのでRGBに変換
            abgr = poly_style.text
            if abgr and len(abgr) == 8:
                rgb = '#' + abgr[6:8] + abgr[4:6] + abgr[2:4]
                style_colors[style_id] = rgb.upper()

    # StyleMapからの参照も解決
    style_map = {}
    for sm in root.findall('.//kml:StyleMap', ns):
        sm_id = sm.get('id', '')
        for pair in sm.findall('kml:Pair', ns):
            key = pair.find('kml:key', ns)
            style_url = pair.find('kml:styleUrl', ns)
            if key is not None and key.text == 'normal' and style_url is not None:
                ref = style_url.text.lstrip('#')
                if ref in style_colors:
                    style_map[sm_id] = style_colors[ref]

    # 全スタイルをマージ
    all_styles = {**style_colors, **style_map}

    # Placemarkを解析
    results = []
    for placemark in root.findall('.//kml:Placemark', ns):
        name_elem = placemark.find('kml:name', ns)
        style_url_elem = placemark.find('kml:styleUrl', ns)

        if name_elem is not None:
            name = name_elem.text or ""
            status = "不明"

            if style_url_elem is not None:
                style_ref = style_url_elem.text.lstrip('#')
                color = all_styles.get(style_ref, "")
                status = STATUS_COLORS.get(color, f"不明({color})")

            results.append({
                "工区": name,
                "ステータス": status
            })

    return results


def save_to_csv(data, filepath):
    """CSVに追記保存"""
    timestamp = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")

    file_exists = os.path.exists(filepath)

    with open(filepath, 'a', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)

        if not file_exists:
            writer.writerow(["取得日時", "工区", "ステータス"])

        for row in data:
            writer.writerow([timestamp, row["工区"], row["ステータス"]])

    return timestamp


def save_to_json(data, dirpath):
    """JSON形式でスナップショット保存"""
    timestamp = datetime.now(JST)
    filename = timestamp.strftime("%Y%m%d_%H%M%S.json")
    filepath = os.path.join(dirpath, filename)

    snapshot = {
        "timestamp": timestamp.isoformat(),
        "data": data
    }

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)

    return filepath


def main():
    print("KMLを取得中...")
    kml_content = fetch_kml()

    print("解析中...")
    data = parse_kml(kml_content)

    print(f"工区数: {len(data)}")

    # データディレクトリ
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, '..', 'data')
    os.makedirs(data_dir, exist_ok=True)

    # CSV保存
    csv_path = os.path.join(data_dir, 'history.csv')
    timestamp = save_to_csv(data, csv_path)
    print(f"CSV保存: {csv_path}")

    # JSONスナップショット保存
    json_path = save_to_json(data, data_dir)
    print(f"JSON保存: {json_path}")

    # ステータス集計
    status_count = {}
    for row in data:
        s = row["ステータス"]
        status_count[s] = status_count.get(s, 0) + 1

    print(f"\n[{timestamp}] ステータス集計:")
    for status, count in sorted(status_count.items()):
        print(f"  {status}: {count}件")


if __name__ == "__main__":
    main()
