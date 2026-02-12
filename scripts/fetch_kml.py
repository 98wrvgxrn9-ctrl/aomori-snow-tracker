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

import gspread
from google.oauth2.service_account import Credentials
import requests

# Google Sheets設定
SPREADSHEET_ID = "1Wd_2gVBruM-fwAZB3KkRxIEn1bOSVph0VFJfPwI2UH8"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

# Google マイマップのKMLエクスポートURL
MAPS = {
    "koku": {
        "name": "工区",
        "url": "https://www.google.com/maps/d/kml?mid=1mxHDM5k2sxUVybf8m92CTkiGtCAkUKA",
        "name_field": "name",
        "col_name": "工区",
    },
    "rosen": {
        "name": "路線",
        "url": "https://www.google.com/maps/d/kml?mid=1I1f6K3ct-wRb3Tk87eXZbwsbe55cVxY",
        "name_field": "description",
        "col_name": "路線",
    },
}

# ステータスの色コード対応（フォールバック用）
STATUS_COLORS = {
    "#DB4436": "作業中",
    "#0288D1": "現場確認中",
    "#FFDD5E": "作業予定あり",
    "#FF5252": "作業中",
    "#FFD600": "作業予定あり",
    "#FBC02D": "作業予定あり",
    "#FFEA00": "作業予定あり",
}

# 日本時間
JST = timezone(timedelta(hours=9))


def fetch_kml(url):
    """KMZ(ZIP)をダウンロードしてKMLを抽出"""
    response = requests.get(url, timeout=30)
    response.raise_for_status()

    with zipfile.ZipFile(BytesIO(response.content)) as zf:
        for name in zf.namelist():
            if name.endswith('.kml'):
                return zf.read(name).decode('utf-8')

    raise ValueError("KMLファイルが見つかりません")


def get_extended_data(placemark, ns):
    """PlacemarkからExtendedDataをdict形式で取得"""
    ext = {}
    for data_elem in placemark.findall('kml:ExtendedData/kml:Data', ns):
        key = data_elem.get('name', '')
        value_elem = data_elem.find('kml:value', ns)
        ext[key] = value_elem.text if value_elem is not None and value_elem.text else ""
    return ext


def get_color_from_style(placemark, all_styles, ns):
    """Placemarkのスタイルから色コードを取得"""
    style_url_elem = placemark.find('kml:styleUrl', ns)
    if style_url_elem is not None:
        style_ref = style_url_elem.text.lstrip('#')
        return all_styles.get(style_ref, "")
    return ""


def parse_kml(kml_content, name_field="name"):
    """KMLを解析して工区/路線ごとのステータスを抽出"""
    root = ET.fromstring(kml_content)

    # KML名前空間
    ns = {'kml': 'http://www.opengis.net/kml/2.2'}

    # スタイルID→色のマッピングを構築
    style_colors = {}
    for style in root.findall('.//kml:Style', ns):
        style_id = style.get('id', '')
        poly_style = style.find('.//kml:PolyStyle/kml:color', ns)
        line_style = style.find('.//kml:LineStyle/kml:color', ns)

        color_elem = poly_style if poly_style is not None else line_style
        if color_elem is not None:
            abgr = color_elem.text
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

    all_styles = {**style_colors, **style_map}

    # Placemarkを解析
    results = []
    for placemark in root.findall('.//kml:Placemark', ns):
        name_elem = placemark.find('kml:name', ns)
        ext = get_extended_data(placemark, ns)

        if ext:
            # 新マップ形式: ExtendedDataから構造化データを取得
            if name_field == "description":
                # 路線: nameが路線名、ExtendedDataに作業状況等
                item_name = name_elem.text if name_elem is not None else ""
                status = ext.get("作業状況", "不明")
            else:
                # 工区: ExtendedDataに工区名等、nameはステータステキスト
                item_name = ext.get("工区名", "")
                status = name_elem.text if name_elem is not None else "不明"

            if item_name:
                row = {
                    "名前": item_name,
                    "ステータス": status,
                }
                if ext.get("直近作業予定日"):
                    row["直近作業予定日"] = ext["直近作業予定日"]
                if ext.get("指令"):
                    row["指令"] = ext["指令"]
                if ext.get("更新日時"):
                    row["更新日時"] = ext["更新日時"]
                if ext.get("お知らせ"):
                    row["お知らせ"] = ext["お知らせ"]
                results.append(row)
        else:
            # 旧マップ形式: フォールバック
            desc_elem = placemark.find('kml:description', ns)
            if name_field == "description":
                item_name = desc_elem.text if desc_elem is not None and desc_elem.text else ""
                status = name_elem.text if name_elem is not None and name_elem.text else "不明"
            else:
                item_name = name_elem.text if name_elem is not None else ""
                color = get_color_from_style(placemark, all_styles, ns)
                status = STATUS_COLORS.get(color, f"不明({color})")

            if item_name:
                results.append({
                    "名前": item_name,
                    "ステータス": status
                })

    return results


def save_to_csv(data, filepath, col_name="工区"):
    """CSVに追記保存"""
    timestamp = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")

    has_extended = any("直近作業予定日" in row for row in data)
    file_exists = os.path.exists(filepath)

    with open(filepath, 'a', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)

        if not file_exists:
            header = ["取得日時", col_name, "ステータス"]
            if has_extended:
                header += ["直近作業予定日", "指令", "更新日時", "お知らせ"]
            writer.writerow(header)

        for row in data:
            csv_row = [timestamp, row["名前"], row["ステータス"]]
            if has_extended:
                csv_row += [
                    row.get("直近作業予定日", ""),
                    row.get("指令", ""),
                    row.get("更新日時", ""),
                    row.get("お知らせ", ""),
                ]
            writer.writerow(csv_row)

    return timestamp


def save_to_json(data, dirpath, prefix=""):
    """JSON形式でスナップショット保存"""
    timestamp = datetime.now(JST)
    if prefix:
        filename = f"{prefix}_{timestamp.strftime('%Y%m%d_%H%M%S')}.json"
    else:
        filename = timestamp.strftime("%Y%m%d_%H%M%S.json")
    filepath = os.path.join(dirpath, filename)

    snapshot = {
        "timestamp": timestamp.isoformat(),
        "data": data
    }

    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)

    return filepath


def save_to_sheets(data):
    """Googleスプレッドシートに追記"""
    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if not creds_json:
        print("GOOGLE_CREDENTIALS_JSON環境変数が設定されていません。スプレッドシート保存をスキップ。")
        return None

    creds_data = json.loads(creds_json)
    creds = Credentials.from_service_account_info(creds_data, scopes=SCOPES)
    client = gspread.authorize(creds)

    spreadsheet = client.open_by_key(SPREADSHEET_ID)
    sheet = spreadsheet.sheet1

    timestamp = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")

    # ヘッダーがなければ追加
    if sheet.row_count == 0 or sheet.cell(1, 1).value != "取得日時":
        sheet.append_row(["取得日時", "工区", "ステータス"])

    # データを追記
    rows = [[timestamp, row["工区"], row["ステータス"]] for row in data]
    sheet.append_rows(rows)

    return timestamp


def main():
    # データディレクトリ
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, '..', 'data')
    os.makedirs(data_dir, exist_ok=True)

    for map_id, map_info in MAPS.items():
        print(f"\n=== {map_info['name']}（{map_id}）===")

        print("KMLを取得中...")
        kml_content = fetch_kml(map_info['url'])

        print("解析中...")
        data = parse_kml(kml_content, name_field=map_info.get('name_field', 'name'))

        print(f"件数: {len(data)}")

        # CSV保存（マップごとに別ファイル）
        csv_path = os.path.join(data_dir, f'history_{map_id}.csv')
        timestamp = save_to_csv(data, csv_path, col_name=map_info.get('col_name', '名前'))
        print(f"CSV保存: {csv_path}")

        # JSONスナップショット保存
        json_path = save_to_json(data, data_dir, prefix=map_id)
        print(f"JSON保存: {json_path}")

        # ステータス集計
        status_count = {}
        for row in data:
            s = row["ステータス"]
            status_count[s] = status_count.get(s, 0) + 1

        print(f"[{timestamp}] ステータス集計:")
        for status, count in sorted(status_count.items()):
            print(f"  {status}: {count}件")


if __name__ == "__main__":
    main()
