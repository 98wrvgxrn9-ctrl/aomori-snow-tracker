#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
青森市の気象データ（日次降雪）をJMAから取得し、分析用CSVを更新する。

生成ファイル:
- data/analysis/aomori_snowfall_daily.csv
- data/by_prefecture/aomori_snowfall_daily.csv
- data/analysis/winter_snowfall_summary.csv
- data/analysis/fms_posts_vs_snowfall_daily.csv
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from io import StringIO
from pathlib import Path
import calendar

import pandas as pd
import requests


@dataclass(frozen=True)
class JmaStation:
    name: str
    prec_no: str
    block_no: str


AOMORI_STATION = JmaStation(name="青森", prec_no="31", block_no="47575")


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def flatten_columns(columns: pd.Index) -> list[str]:
    flat = []
    for col in columns:
        if isinstance(col, tuple):
            parts = []
            for p in col:
                s = str(p).strip()
                if not s or s.startswith("Unnamed"):
                    continue
                parts.append(s)
            flat.append("_".join(parts))
        else:
            flat.append(str(col).strip())
    return flat


def to_number(series: pd.Series) -> pd.Series:
    cleaned = (
        series.astype(str)
        .str.strip()
        .replace(
            {
                "--": None,
                "///": None,
                "×": None,
                "nan": None,
            }
        )
    )
    return pd.to_numeric(cleaned, errors="coerce")


def fetch_month(station: JmaStation, year: int, month: int, timeout: int = 30) -> pd.DataFrame:
    url = (
        "https://www.data.jma.go.jp/stats/etrn/view/daily_s1.php"
        f"?prec_no={station.prec_no}&block_no={station.block_no}"
        f"&year={year}&month={month}&day=&view="
    )
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()

    try:
        tables = pd.read_html(StringIO(resp.text))
    except ValueError:
        return pd.DataFrame()
    if not tables:
        return pd.DataFrame()

    table = tables[0].copy()
    table.columns = flatten_columns(table.columns)

    day_col = next((c for c in table.columns if c.startswith("日")), None)
    snow_col = next(
        (
            c
            for c in table.columns
            if ("雪(cm)" in c) and ("降雪" in c or c.endswith("合計"))
        ),
        None,
    )
    depth_col = next(
        (
            c
            for c in table.columns
            if ("雪(cm)" in c) and ("最深積雪" in c or c.endswith("値"))
        ),
        None,
    )
    temp_col = next(
        (c for c in table.columns if "気温" in c and "平均" in c),
        None,
    )

    if day_col is None or snow_col is None:
        return pd.DataFrame()

    day = to_number(table[day_col])
    snowfall = to_number(table[snow_col]).fillna(0)
    max_depth = to_number(table[depth_col]) if depth_col else pd.Series([None] * len(table))
    temp_avg = to_number(table[temp_col]) if temp_col else pd.Series([None] * len(table))

    out = pd.DataFrame(
        {
            "date": pd.to_datetime(
                {"year": year, "month": month, "day": day.astype("Int64")},
                errors="coerce",
            ),
            "snowfall_cm": snowfall,
            "max_snow_depth_cm": max_depth,
            "temp_avg_c": temp_avg,
            "station_name": station.name,
        }
    )
    out = out.dropna(subset=["date"]).sort_values("date")
    return out


def build_daily_dataset(start_year: int, end_year: int, end_month: int) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for year in range(start_year, end_year + 1):
        max_month = end_month if year == end_year else 12
        for month in range(1, max_month + 1):
            frames.append(fetch_month(AOMORI_STATION, year, month))

    if not frames:
        return pd.DataFrame(columns=["date", "snowfall_cm", "max_snow_depth_cm", "station_name"])

    daily = pd.concat(frames, ignore_index=True)
    daily = daily.drop_duplicates(subset=["date"], keep="last").sort_values("date")
    daily["date"] = pd.to_datetime(daily["date"]).dt.date
    today = datetime.now().date()
    daily = daily[daily["date"] <= today].copy()
    return daily


def build_winter_summary(daily: pd.DataFrame) -> pd.DataFrame:
    if daily.empty:
        return pd.DataFrame(
            columns=[
                "season",
                "total_snowfall_cm",
                "days_recorded",
                "expected_days",
                "is_complete",
                "start_date",
                "end_date",
            ]
        )

    d = daily.copy()
    d["date"] = pd.to_datetime(d["date"])
    d = d[d["date"].dt.month.isin([12, 1, 2, 3])].copy()

    season_end = d["date"].dt.year.where(d["date"].dt.month <= 3, d["date"].dt.year + 1)
    d["season_end"] = season_end
    d["season"] = (season_end - 1).astype(str) + "-" + season_end.astype(str).str[-2:]

    summary = (
        d.groupby(["season", "season_end"], as_index=False)
        .agg(
            total_snowfall_cm=("snowfall_cm", "sum"),
            days_recorded=("date", "count"),
            start_date=("date", "min"),
            end_date=("date", "max"),
        )
        .sort_values("season")
    )

    def expected_days(season_end_year: int) -> int:
        feb_days = 29 if calendar.isleap(int(season_end_year)) else 28
        return 31 + 31 + feb_days + 31

    summary["expected_days"] = summary["season_end"].apply(expected_days)
    summary["is_complete"] = summary["days_recorded"] >= summary["expected_days"]
    summary = summary.drop(columns=["season_end"])
    return summary


def build_fms_daily_compare(root: Path, daily: pd.DataFrame) -> pd.DataFrame:
    fms_path = root / "data" / "raw" / "fms" / "by_prefecture" / "2_青森県.csv"
    fms = pd.read_csv(fms_path)

    fms_dt = pd.to_datetime(fms["pub_date"], errors="coerce", utc=True)
    fms_date_jst = fms_dt.dt.tz_convert("Asia/Tokyo").dt.date
    posts = (
        pd.DataFrame({"date": fms_date_jst})
        .dropna(subset=["date"])
        .groupby("date", as_index=False)
        .size()
        .rename(columns={"size": "posts"})
    )

    merged = daily[["date", "snowfall_cm", "max_snow_depth_cm"]].merge(posts, on="date", how="left")
    merged["posts"] = merged["posts"].fillna(0).astype(int)
    return merged.sort_values("date")


def main() -> None:
    root = repo_root()
    now = datetime.now()

    daily = build_daily_dataset(start_year=2018, end_year=now.year, end_month=now.month)
    winter = build_winter_summary(daily)
    compare = build_fms_daily_compare(root, daily)

    out_analysis_daily = root / "data" / "processed" / "fms" / "aomori_snowfall_daily.csv"
    out_pref_daily = root / "data" / "raw" / "fms" / "by_prefecture" / "aomori_snowfall_daily.csv"
    out_winter = root / "data" / "processed" / "fms" / "winter_snowfall_summary.csv"
    out_compare = root / "data" / "processed" / "fms" / "fms_posts_vs_snowfall_daily.csv"

    out_analysis_daily.parent.mkdir(parents=True, exist_ok=True)
    out_pref_daily.parent.mkdir(parents=True, exist_ok=True)

    daily.to_csv(out_analysis_daily, index=False, encoding="utf-8-sig")
    daily.to_csv(out_pref_daily, index=False, encoding="utf-8-sig")
    winter.to_csv(out_winter, index=False, encoding="utf-8-sig")
    compare.to_csv(out_compare, index=False, encoding="utf-8-sig")

    print("Updated weather datasets:")
    print(f"- {out_analysis_daily}")
    print(f"- {out_pref_daily}")
    print(f"- {out_winter}")
    print(f"- {out_compare}")
    if not daily.empty:
        print(
            "Latest date:",
            daily["date"].max(),
            "| snowfall_cm:",
            float(daily.loc[daily["date"] == daily["date"].max(), "snowfall_cm"].iloc[0]),
        )


if __name__ == "__main__":
    main()
