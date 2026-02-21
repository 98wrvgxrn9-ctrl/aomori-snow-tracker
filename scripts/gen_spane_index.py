#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
スパネ度指数（泥跳ね指数）を工区別に計算し docs/data/spane_index.json を生成する。

スパネ = 津軽弁で「泥」。雪解け期の泥水飛散リスクを 0〜100 で表す。

計算式 (Phase 1 - 融解ポテンシャル × 工区別修正係数):
    base_melt      = max(0, temp_avg_c) × snow_depth_cm   # 市全体共通
    days_factor    = clip(0.3 + days_since_clearance / 14, 0.3, 2.0)
    fms_factor     = 1 + min(1.0, stacked×0.15 + near_stack×0.05)
    area_raw       = base_melt × days_factor × fms_factor
    spane_index    = min(100, int(area_raw / NORM_MAX × 100))

入力:
  - data/processed/fms/aomori_snowfall_daily.csv   (気温・積雪深)
  - docs/data/koku.geojson                          (工区・最終除雪日時)
  - docs/data/fms_risk.json                         (FMS市民報告)

出力:
  - docs/data/spane_index.json
"""

from __future__ import annotations

import json
from datetime import datetime, date
from pathlib import Path

import pandas as pd

# 正規化定数: 青森の最大想定 = 気温15℃ × 積雪200cm × 最大補正2.0 = 6000
NORM_MAX = 6000

# 最終除雪日が不明な場合のデフォルト経過日数
DEFAULT_DAYS_SINCE = 30


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_daily_weather(root: Path) -> tuple[float | None, float | None, str | None]:
    """日次CSVから最新の気温・積雪深を返す。"""
    csv_path = root / "data" / "processed" / "fms" / "aomori_snowfall_daily.csv"
    df = pd.read_csv(csv_path, parse_dates=["date"])
    df = df.sort_values("date").reset_index(drop=True)

    valid_snow = df.dropna(subset=["max_snow_depth_cm"])
    valid_temp = df.dropna(subset=["temp_avg_c"])
    if valid_snow.empty:
        return None, None, None

    snow_row = valid_snow.iloc[-1]
    temp_row = valid_temp.iloc[-1] if not valid_temp.empty else None
    temp = float(temp_row["temp_avg_c"]) if temp_row is not None else None
    snow = float(snow_row["max_snow_depth_cm"])
    snow_date = pd.to_datetime(snow_row["date"]).strftime("%Y-%m-%d")
    return temp, snow, snow_date


def load_current_temperature(root: Path) -> tuple[float | None, str | None]:
    """current_weather.json から現在気温と観測時刻を返す。"""
    path = root / "docs" / "data" / "current_weather.json"
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None, None
    except json.JSONDecodeError:
        return None, None

    current = data.get("current", {}) if isinstance(data, dict) else {}
    temp = current.get("temperature_c")
    observed_at = current.get("observed_at")
    if temp is None:
        return None, None
    return float(temp), str(observed_at) if observed_at else None


def load_weather(root: Path) -> tuple[float | None, float | None, str, str | None, str | None]:
    """気温・積雪深を返す。気温は現在気温JSONを優先し、失敗時は日次CSVにフォールバック。"""
    daily_temp, snow_depth, snow_date = load_daily_weather(root)
    current_temp, observed_at = load_current_temperature(root)

    if current_temp is not None and snow_depth is not None:
        return current_temp, snow_depth, "current_weather", observed_at, snow_date
    if daily_temp is not None and snow_depth is not None:
        return daily_temp, snow_depth, "daily_weather", None, snow_date
    return None, None, "none", None, None


def load_koku(root: Path) -> list[dict]:
    """koku.geojson から工区名・最終除雪日時・指令を読み込む。"""
    path = root / "docs" / "data" / "koku.geojson"
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("features", [])


def load_fms_risk(root: Path) -> dict:
    """fms_risk.json の areas dict を返す。"""
    path = root / "docs" / "data" / "fms_risk.json"
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("areas", {})
    except FileNotFoundError:
        return {}


def parse_clearance_date(dt_str: str | None) -> date | None:
    """'2026-02-11 06:34:15' 形式をパースして date を返す。"""
    if not dt_str:
        return None
    try:
        return datetime.strptime(dt_str.strip(), "%Y-%m-%d %H:%M:%S").date()
    except ValueError:
        return None


def spane_level(idx: int) -> str:
    if idx >= 70:
        return "危"
    elif idx >= 40:
        return "高"
    elif idx >= 15:
        return "中"
    return "低"


def calc_zones(
    temp_avg_c: float,
    snow_depth_cm: float,
    features: list[dict],
    fms_risk: dict,
    today: date,
) -> dict:
    base_melt = max(0.0, temp_avg_c) * snow_depth_cm
    zones: dict[str, dict] = {}

    for feat in features:
        props = feat.get("properties", {})
        name: str = props.get("名前", "")
        if not name:
            continue

        # 最終除雪日からの経過日数
        clearance_dt = parse_clearance_date(props.get("最終除雪日時"))
        if clearance_dt:
            days_since = (today - clearance_dt).days
        else:
            days_since = DEFAULT_DAYS_SINCE
        days_since = max(0, days_since)

        days_factor = min(2.0, 0.3 + days_since / 14)

        # FMS補正
        fms = fms_risk.get(name, {})
        risk = fms.get("risk", {}) if isinstance(fms, dict) else {}
        stacked = risk.get("stacked", 0)
        near_stack = risk.get("near_stack", 0)
        fms_factor = 1.0 + min(1.0, stacked * 0.15 + near_stack * 0.05)

        raw = base_melt * days_factor * fms_factor
        idx = min(100, int(raw / NORM_MAX * 100))

        zones[name] = {
            "spane_index": idx,
            "level": spane_level(idx),
            "days_since_clearance": days_since,
        }

    return zones


def main() -> None:
    root = repo_root()
    today = date.today()

    temp_avg_c, snow_depth_cm, temp_source, temp_observed_at, snow_depth_date = load_weather(root)
    if temp_avg_c is None or snow_depth_cm is None:
        print("気象データが取得できませんでした。スキップします。")
        return

    features = load_koku(root)
    fms_risk = load_fms_risk(root)

    zones = calc_zones(temp_avg_c, snow_depth_cm, features, fms_risk, today)

    base_melt = max(0.0, temp_avg_c) * snow_depth_cm
    city_spane = min(100, int(base_melt / NORM_MAX * 100))

    # サマリー（最高スパネ度の工区）
    top = max(zones.items(), key=lambda x: x[1]["spane_index"], default=(None, {}))

    result = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "date": today.isoformat(),
        "base": {
            "temp_avg_c": temp_avg_c,
            "temp_source": temp_source,
            "temp_observed_at": temp_observed_at,
            "snow_depth_cm": snow_depth_cm,
            "snow_depth_date": snow_depth_date,
            "city_spane": city_spane,
        },
        "top_zone": {"name": top[0], **top[1]} if top[0] else None,
        "zones": zones,
    }

    out_path = root / "docs" / "data" / "spane_index.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"工区数: {len(zones)} / 気温: {temp_avg_c}℃ / 積雪深: {snow_depth_cm}cm")
    if top[0]:
        print(f"最高スパネ度: {top[1]['spane_index']}（{top[0]}）")
    print(f"出力: {out_path}")


if __name__ == "__main__":
    main()
