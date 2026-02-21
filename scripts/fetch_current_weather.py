#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
青森市の現在気温を取得してJSONに保存する。

出力:
- docs/data/current_weather.json
- data/processed/fms/current_weather.json
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import requests


AOMORI_LAT = 40.8246
AOMORI_LON = 140.7400
TIMEZONE = "Asia/Tokyo"
API_URL = "https://api.open-meteo.com/v1/forecast"


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def fetch_current_temperature(timeout: int = 20) -> dict:
    params = {
        "latitude": AOMORI_LAT,
        "longitude": AOMORI_LON,
        "current": "temperature_2m,weather_code",
        "timezone": TIMEZONE,
    }
    resp = requests.get(API_URL, params=params, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()

    current = data.get("current", {}) if isinstance(data, dict) else {}
    temp = current.get("temperature_2m")
    observed_at = current.get("time")
    weather_code = current.get("weather_code")

    if temp is None or observed_at is None:
        raise RuntimeError("current weather payload is missing required fields")

    return {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "location": {
            "name": "青森市",
            "lat": AOMORI_LAT,
            "lon": AOMORI_LON,
        },
        "source": {
            "name": "Open-Meteo",
            "url": API_URL,
        },
        "current": {
            "temperature_c": float(temp),
            "observed_at": str(observed_at),
            "weather_code": weather_code,
        },
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def main() -> None:
    root = repo_root()
    out_docs = root / "docs" / "data" / "current_weather.json"
    out_processed = root / "data" / "processed" / "fms" / "current_weather.json"

    try:
        payload = fetch_current_temperature()
    except Exception as e:
        if out_docs.exists():
            print(f"Current weather fetch failed; keep previous file: {e}")
            return
        raise

    write_json(out_docs, payload)
    write_json(out_processed, payload)
    print(
        "Updated current weather:",
        payload["current"]["temperature_c"],
        "C @",
        payload["current"]["observed_at"],
    )


if __name__ == "__main__":
    main()
