#!/usr/bin/env python3
"""国交省 除雪管理システムから国道の除雪状況KMLを取得しGeoJSONに変換する"""

import json
import os
import xml.etree.ElementTree as ET
import urllib.request

# 除雪完了KML（リアルタイム更新）
COMPLETE_KML_URL = "https://www.aomori-josetsu.jp/josetsugps/fileview/kmlfile_complete_from_subscriber_id/1/"
# 国道路線KML（路線の位置）
KOKUDO_KML_URL = "https://www.aomori-josetsu.jp/josetsugps/fileview/kmlfile_kokudo_from_subscriber_id/1/"

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "kokudo_status.geojson")

# 青森市周辺のバウンディングボックス（少し広めに取る）
AOMORI_BBOX = {
    "lat_min": 40.70,
    "lat_max": 40.95,
    "lon_min": 140.60,
    "lon_max": 141.00,
}

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}

# スタイルとステータスの対応
STYLE_STATUS = {
    "line1": "未除雪",
    "line2": "除雪済み",
    "line3": "作業中",
}

STYLE_COLORS = {
    "line1": "#cccccc",
    "line2": "#16a085",
    "line3": "#f1c40f",
}


def fetch_url(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8")


def parse_coords(text):
    """KML coordinates文字列を [lon, lat] のリストに変換"""
    coords = []
    for pt in text.strip().split():
        parts = pt.split(",")
        if len(parts) >= 2:
            lon, lat = float(parts[0]), float(parts[1])
            coords.append([lon, lat])
    return coords


def is_in_aomori(coords):
    """座標リストの少なくとも一部が青森市付近にあるか"""
    for lon, lat in coords:
        if (AOMORI_BBOX["lat_min"] <= lat <= AOMORI_BBOX["lat_max"] and
                AOMORI_BBOX["lon_min"] <= lon <= AOMORI_BBOX["lon_max"]):
            return True
    return False


def parse_complete_kml(kml_text):
    """除雪完了KMLをパースしてGeoJSON featuresを返す"""
    root = ET.fromstring(kml_text)
    features = []

    for folder in root.findall(".//kml:Folder", KML_NS):
        folder_name = folder.findtext("kml:name", "", KML_NS).strip()
        status = STYLE_STATUS.get(folder_name, folder_name)
        color = STYLE_COLORS.get(folder_name, "#999999")

        # 未除雪(line1)はスキップ（数が多く地図が見づらくなる）
        if folder_name == "line1":
            continue

        for pm in folder.findall("kml:Placemark", KML_NS):
            coords_el = pm.find(".//kml:coordinates", KML_NS)
            if coords_el is None or not coords_el.text:
                continue

            coords = parse_coords(coords_el.text)
            if not coords or not is_in_aomori(coords):
                continue

            name = pm.findtext("kml:name", "", KML_NS).strip()

            feature = {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords,
                },
                "properties": {
                    "id": name,
                    "status": status,
                    "color": color,
                    "source": "国交省除雪管理システム",
                },
            }
            features.append(feature)

    return features


def main():
    print("国道除雪状況KMLを取得中...")
    kml_text = fetch_url(COMPLETE_KML_URL)
    print(f"KMLサイズ: {len(kml_text)} bytes")

    features = parse_complete_kml(kml_text)
    print(f"青森市付近の除雪済み・作業中区間: {len(features)}件")

    # ステータス別集計
    from collections import Counter
    status_count = Counter(f["properties"]["status"] for f in features)
    for s, c in status_count.items():
        print(f"  {s}: {c}件")

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    print(f"保存: {OUT_PATH}")


if __name__ == "__main__":
    main()
