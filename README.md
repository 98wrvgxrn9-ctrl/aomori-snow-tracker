# aomori-snow-tracker

青森市の除排雪、道路、バス、気象、市民投稿、子育てイベントなどの生活情報を取得・整形・公開する civic tech / open data プロジェクトです。

雪国の生活情報は、自治体ページ、地図、RSS、交通情報、気象データなどに分散しています。このリポジトリは、それらを継続取得して履歴化し、地域住民・市民団体・地域メディア・開発者が再利用しやすい JSON / GeoJSON / CSV として公開することを目的にしています。

## What This Provides

- 青森市の除排雪出動・作業状況の履歴記録
- 国交省・自治体・交通・気象・FixMyStreet Japan 由来データの取得と整形
- 地図表示向けの GeoJSON / JSON データ
- 降雪、道路、投稿傾向を組み合わせた生活リスク分析
- GitHub Actions による定期更新パイプライン
- GitHub Pages / Firebase Hosting 向けの公開フロントエンド

## Public App

- Repository: https://github.com/98wrvgxrn9-ctrl/aomori-snow-tracker
- Data and static app: `docs/`

## Data Sources

主なデータソースは以下です。

- あおもりSNOW情報
- 国土交通省・道路関連公開データ
- 青森市営バス運行情報
- 気象データ
- FixMyStreet Japan RSS / 投稿データ
- 青森市・周辺地域の子育て、暮らし関連公開情報

各データの取得・加工フローは [docs/DATA_FLOW.md](docs/DATA_FLOW.md) を参照してください。

## Repository Structure

```text
.
├── data/
│   ├── raw/          # 取得元に近い形式のデータ
│   └── processed/    # 公開・分析向けに整形したデータ
├── docs/             # 静的公開アプリ、公開データ、運用ドキュメント
├── frontend/         # フロントエンドの元実装
├── scripts/          # データ取得・加工・分析スクリプト
└── .github/workflows # 定期取得、デプロイ、セキュリティスキャン
```

## Key Outputs

| File | Description |
|---|---|
| `data/history.csv` | 除排雪情報の時系列履歴 |
| `data/processed/koku.geojson` | 工区・道路関連データ |
| `data/processed/kokudo_status.geojson` | 国交省由来の道路・除雪状況 |
| `data/processed/bus_status.json` | 青森市営バスの運行情報 |
| `data/processed/current_weather.json` | 現在の気象情報 |
| `data/processed/fms_risk.json` | FixMyStreet投稿などから生成した生活リスク情報 |
| `docs/data/*.json`, `docs/data/*.geojson` | 公開フロントエンド用データ |

## Snow Status Colors

| Color | Status |
|---|---|
| Red | 作業中 |
| Blue | 現場確認中 |
| Yellow | 作業予定あり |

## Quick Start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/fetch_kml.py
```

FMS 関連スクリプトを実行する場合:

```bash
pip install -r scripts/fms/requirements.txt
python scripts/fms/fetch_rss.py
```

## Automation

GitHub Actions で定期的にデータを取得・加工します。

| Workflow | Purpose |
|---|---|
| `.github/workflows/fetch.yml` | 除排雪・道路系データの定期更新 |
| `.github/workflows/fetch_rss.yml` | FixMyStreet RSS の取得 |
| `.github/workflows/fetch_weather.yml` | 気象データ更新 |
| `.github/workflows/refresh_kosodate.yml` | 子育てイベント情報更新 |
| `.github/workflows/codeql.yml` | CodeQL セキュリティスキャン |

## Contributing

地域データの追加、データ取得スクリプトの修正、表示改善、ドキュメント改善を歓迎します。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## Security

脆弱性報告の方針は [SECURITY.md](SECURITY.md) を参照してください。

## License

コードは [MIT License](LICENSE) で公開しています。

データセットには第三者の公開データ、自治体・交通・気象・FixMyStreet Japan 由来の情報が含まれます。各データの再利用条件は元データ提供元の規約に従ってください。

## Status

実験的な実装を含むプロトタイプです。冬季運用、地域データ整備、公開データ品質改善を継続しています。
