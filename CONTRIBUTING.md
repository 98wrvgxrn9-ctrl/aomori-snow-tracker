# Contributing

`aomori-snow-tracker` は、青森市周辺の生活情報を継続的に取得・整形・公開する civic tech / open data プロジェクトです。地域データの改善、データ取得スクリプトの修正、地図表示、ドキュメント整備を歓迎します。

## Ways to Contribute

- 除排雪、道路、バス、気象、子育て、防災などの公開データソースを提案する
- 既存スクリプトの取得失敗、形式変更、重複、欠損を報告する
- JSON / GeoJSON / CSV の加工ロジックを改善する
- 地図表示やアクセシビリティを改善する
- ドキュメント、データフロー、運用手順を更新する
- 青森市以外の雪国自治体で再利用できるように汎用化する

## Before Opening an Issue

Issue を作る前に、可能な範囲で以下を書いてください。

- 何が起きたか
- 期待する結果
- 関係するデータソースやURL
- 実行したコマンド
- エラーログやスクリーンショット
- 影響範囲（表示だけ、データ更新停止、公開データ欠損など）

## Pull Request Guidelines

1. 変更範囲を小さく保ってください。
2. データ取得元の規約や公開範囲を確認してください。
3. 個人情報、非公開情報、APIキー、トークンをコミットしないでください。
4. 生成データを更新する場合は、どのスクリプトで生成したかをPR本文に書いてください。
5. 可能であれば、実行した確認コマンドをPR本文に書いてください。

## Local Development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python scripts/fetch_kml.py
```

FMS 関連:

```bash
pip install -r scripts/fms/requirements.txt
python scripts/fms/fetch_rss.py
```

## Data Policy

このリポジトリには、第三者の公開データ、自治体・交通・気象・FixMyStreet Japan 由来の情報が含まれます。

- 元データ提供元の利用規約を尊重してください。
- 個人を特定できる情報や非公開情報を追加しないでください。
- 公開投稿データを扱う場合も、必要以上の個人情報を含めないでください。
- データの正確性は保証されません。生活判断や安全判断では必ず公式情報を確認してください。

## Security

脆弱性を見つけた場合は、公開Issueに詳細な攻撃手順を書かず、[SECURITY.md](SECURITY.md) の手順に従ってください。
