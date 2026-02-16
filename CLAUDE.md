# 青森除雪ウォッチ — プロジェクトメモ

## リポジトリ構成

- `docs/` — Firebase Hostingで公開される静的サイト（index.html + データJSON/GeoJSON）
- `scripts/` — データ生成スクリプト（Python）
- `data/` — 生データ（スクレイピング結果など）

### 関連リポジトリ（private）

- `fms-data` — FMS(FixMyStreet)投稿をRSSで取得・蓄積。`scripts/fetch_rss.py` が本体
- `fms-workspace` / `fms-analysis` — FMS分析用
- `fms-aomori-history` — 除雪RPG（index.html）や流雪溝ジオコーディングスクリプトが入っている（※旧desktop-tutorialリポは削除済み）

## デプロイ

- Firebase Hosting: https://aomori-snow-tracker.web.app/
- GitHub Pagesではなく `docs/` をFirebaseで配信
- pushすると自動デプロイ

## X（旧Twitter）

- アカウント: @aomori_snowatch
- プロジェクト公開済み

## FMSデータフロー

1. `fms-data/scripts/fetch_rss.py` — 全国162自治体のRSSから投稿取得→都道府県別CSV蓄積
2. `scripts/gen_fms_risk.py` — CSVから直近7日間を抽出→工区/路線マッチ→`docs/data/fms_risk.json`生成
3. フロントエンドが `fms_risk.json` を読んで表示
4. 7日間のスライディングウィンドウで毎日更新（古い投稿は自動で入れ替わる）

## 将来の構想（未着手）

- **表示切り替え（レイヤートグル）** — 友達のマップ(dev.snrc.ymachida.com)のようにチェックボックスで工区/路線/FMS/SNS/流雪溝などをON/OFF
- **自作マップとの連携** — 除雪RPG(fms-aomori-history)と将来的に接続
- **FMS投稿との関連付け** — RPG内イベントにFMS投稿データを反映
- **雪寄場の拡充** — 既存の雪捨て場データに加えて雪寄場もマッピング
- **流雪溝データの拡充** — 現在9施設（ポンプ場・排水樋門・取水位置）。路線データや追加施設の反映を継続
- **紹介動画の埋め込み** — NotebookLMで生成した解説動画をYouTubeにアップし、モーダル内にiframeで埋め込む（YouTube URL確定待ち）

## コミット時の注意

- gitignoreの変更が未コミットで残っていることがある
- bashでcdが効かない場合は `GIT_DIR` / `GIT_WORK_TREE` 環境変数で回避
