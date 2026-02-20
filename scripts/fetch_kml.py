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
SUPPORT_ZONE_KEYWORDS = ("応援除雪工区", "県財政支援")


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


def extract_coordinates(placemark, ns):
    """Placemarkから座標を抽出し、GeoJSONジオメトリを返す"""
    # Polygon（工区用）
    coords_elem = placemark.find('.//kml:Polygon//kml:coordinates', ns)
    if coords_elem is not None and coords_elem.text:
        ring = []
        for coord in coords_elem.text.strip().split():
            parts = coord.split(',')
            if len(parts) >= 2:
                ring.append([float(parts[0]), float(parts[1])])
        if ring:
            return {"type": "Polygon", "coordinates": [ring]}

    # LineString（路線用）
    coords_elem = placemark.find('.//kml:LineString/kml:coordinates', ns)
    if coords_elem is not None and coords_elem.text:
        line = []
        for coord in coords_elem.text.strip().split():
            parts = coord.split(',')
            if len(parts) >= 2:
                line.append([float(parts[0]), float(parts[1])])
        if line:
            return {"type": "LineString", "coordinates": line}

    # Point（フォールバック）
    coords_elem = placemark.find('.//kml:Point/kml:coordinates', ns)
    if coords_elem is not None and coords_elem.text:
        parts = coords_elem.text.strip().split(',')
        if len(parts) >= 2:
            return {"type": "Point", "coordinates": [float(parts[0]), float(parts[1])]}

    return None


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
        geometry = extract_coordinates(placemark, ns)

        if ext:
            # 新マップ形式: ExtendedDataから構造化データを取得
            if name_field == "description":
                # 路線: ExtendedDataの「路線名」が路線名、nameがステータス
                item_name = ext.get("路線名", "")
                status = name_elem.text if name_elem is not None else "不明"
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
                if ext.get("作業予定期間"):
                    row["作業予定期間"] = ext["作業予定期間"]
                if ext.get("指令"):
                    row["指令"] = ext["指令"]
                if ext.get("更新日時"):
                    row["更新日時"] = ext["更新日時"]
                if ext.get("お知らせ"):
                    row["お知らせ"] = ext["お知らせ"]
                if geometry:
                    row["_geometry"] = geometry
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
                row = {
                    "名前": item_name,
                    "ステータス": status,
                }
                if geometry:
                    row["_geometry"] = geometry
                results.append(row)

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


def normalize_name(name):
    """名前の全角/半角を正規化して比較用キーを返す"""
    import unicodedata
    return unicodedata.normalize('NFKC', name)


def load_last_work_dates(csv_path):
    """履歴CSVから各エリアの最終作業日（ステータスが「作業中」だった最後の日時）を取得"""
    last_work = {}
    if not os.path.exists(csv_path):
        return last_work

    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        try:
            next(reader)  # ヘッダースキップ
        except StopIteration:
            return last_work

        for row in reader:
            if len(row) < 3:
                continue
            timestamp, name, status = row[0], row[1], row[2]
            if '作業中' in status:
                # 元の名前と正規化した名前の両方で記録
                last_work[name] = timestamp
                last_work[normalize_name(name)] = timestamp

    return last_work


def load_directive_start_dates(csv_path):
    """履歴CSVから各エリアの現在の指令/作業がいつから続いているかを取得"""
    first_active = {}
    if not os.path.exists(csv_path):
        return first_active

    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.reader(f)
        try:
            next(reader)
        except StopIteration:
            return first_active

        for row in reader:
            if len(row) < 3:
                continue
            ts, name, status = row[0], row[1], row[2]
            shirei = row[4] if len(row) > 4 else ''

            is_active = ('作業中' in status or
                         '作業予定あり' in status or
                         shirei in ('新規指令', '継続指令'))

            nname = normalize_name(name)
            if is_active:
                if nname not in first_active:
                    first_active[nname] = ts
            else:
                if nname in first_active:
                    del first_active[nname]

    return first_active


def save_to_geojson(data, filepath, last_work_dates=None, directive_starts=None):
    """GeoJSON形式で保存（地図表示用）"""
    if last_work_dates is None:
        last_work_dates = {}
    if directive_starts is None:
        directive_starts = {}

    now = datetime.now(JST)

    features = []
    for row in data:
        geometry = row.get("_geometry")
        if not geometry:
            continue
        properties = {k: v for k, v in row.items() if k != "_geometry"}

        name = row.get("名前", "")
        nname = normalize_name(name)

        # 最終除雪日を追加（全角/半角の表記ゆれを吸収）
        last_date = last_work_dates.get(name) or last_work_dates.get(nname)
        if last_date:
            try:
                dt = datetime.strptime(last_date, "%Y-%m-%d %H:%M:%S")
                properties["最終除雪日"] = f"{dt.month}月{dt.day}日"
                properties["最終除雪日時"] = last_date
            except ValueError:
                properties["最終除雪日"] = last_date

        # 指令継続時間を追加
        start_ts = directive_starts.get(nname)
        if start_ts:
            try:
                start_dt = datetime.strptime(start_ts, "%Y-%m-%d %H:%M:%S")
                start_dt = start_dt.replace(tzinfo=JST)
                delta = now - start_dt
                total_hours = int(delta.total_seconds() // 3600)
                days = total_hours // 24
                hours = total_hours % 24
                if days > 0:
                    properties["指令継続"] = f"{days}日{hours}時間"
                else:
                    properties["指令継続"] = f"{hours}時間"
                properties["指令開始日時"] = start_ts
            except ValueError:
                pass

        features.append({
            "type": "Feature",
            "properties": properties,
            "geometry": geometry,
        })

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

    return filepath


def is_support_zone_row(row):
    """工区データから県応援除雪対象を判定"""
    status = row.get("ステータス", "")
    notice = row.get("お知らせ", "")
    text = f"{status} {notice}"
    return any(keyword in text for keyword in SUPPORT_ZONE_KEYWORDS)


def save_support_zones_geojson(koku_data, filepath):
    """工区データから県応援除雪レイヤー用GeoJSONを生成"""
    updated = datetime.now(JST).isoformat()
    features = []

    for row in koku_data:
        if not is_support_zone_row(row):
            continue
        geometry = row.get("_geometry")
        if not geometry:
            continue

        period = row.get("作業予定期間", "")
        properties = {
            "label": "工区のマップを確認ください｡",
            "status": "未定",
            "color": "#757575",
            "工区名": row.get("名前", ""),
            "直近作業予定日": row.get("直近作業予定日", "-"),
            "指令": row.get("指令", "－"),
            "お知らせ": row.get("お知らせ", ""),
            "更新日時": row.get("更新日時", ""),
            "作業予定期間（開始予定日～終了予定日）": "" if period == "-" else period,
            # 互換性向上のため、原データの主要フィールドも保持
            "名前": row.get("名前", ""),
            "ステータス": row.get("ステータス", ""),
            "作業予定期間": period,
        }
        features.append({
            "type": "Feature",
            "properties": properties,
            "geometry": geometry,
        })

    geojson = {
        "type": "FeatureCollection",
        "name": "応援除雪工区（県財政支援）",
        "updated": updated,
        "features": features,
    }

    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(geojson, f, ensure_ascii=False, indent=2)

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

    # GeoJSON出力先（docs/data/）
    docs_data_dir = os.path.join(script_dir, '..', 'docs', 'data')
    os.makedirs(docs_data_dir, exist_ok=True)

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

        # 履歴CSVから最終作業日・指令継続開始日を取得
        last_work_dates = load_last_work_dates(csv_path)
        directive_starts = load_directive_start_dates(csv_path)
        print(f"最終作業日データ: {len(last_work_dates)}件, 指令継続中: {len(directive_starts)}件")

        # GeoJSON保存（地図表示用、毎回上書き）
        geojson_path = os.path.join(docs_data_dir, f'{map_id}.geojson')
        save_to_geojson(data, geojson_path, last_work_dates=last_work_dates, directive_starts=directive_starts)
        print(f"GeoJSON保存: {geojson_path}")

        if map_id == "koku":
            support_geojson_path = os.path.join(docs_data_dir, 'support_zones.geojson')
            save_support_zones_geojson(data, support_geojson_path)
            print(f"GeoJSON保存: {support_geojson_path}")

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
