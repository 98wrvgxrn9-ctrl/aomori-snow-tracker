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

## X投稿の運用

### 基本スタンス
- **行政の評価を行わない**。事実のみを淡々と発信する
- **FMSの投稿内容をそのまま転載しない**。FMS経由で情報を得ていることも書かない
- 市・県の公式マップの更新状況（いつ時点の情報か）を注記し、信ぴょう性を担保する
- 工区名は半角出力（B-8 等）、地名も併記する（例: 金沢2(D-11)）

### 朝の投稿
ユーザーが「朝の投稿」と言ったら、以下の手順で投稿素材を作成する。

1. `docs/data/support_zones.geojson` から県応援除雪の予定を読み込む
2. 本日終了予定・本日開始予定の工区を抽出する
3. `docs/data/areas_meta.json` から工区の地名（address_detail.quarter または address）を取得する
4. 市マップ（`docs/data/koku.geojson`）・県マップの更新日時を確認し、注記に含める
5. 以下のフォーマットで投稿素材を生成する

```
【{日付}朝 県応援除雪の動き】

▼ 本日終了予定
{地名}({工区})／...

▼ 本日開始予定
{地名}({工区})〜{終了日}
...

※市マップの更新は{日時}時点。終了予定の工区が実際に完了したかは現時点で確認できません。
#青森市道路雪情報 #除雪
https://aomori-snow-tracker.web.app
```

### 夜の投稿
ユーザーが「夜の投稿」と言ったら、朝と同様にgeojsonデータから投稿素材を作成する。
- 翌日の県応援除雪の開始・終了予定
- 市マップの今夜の作業予定（koku.geojsonのステータス・指令）

※旧スクリプト（gen_daily_x_posts.py, gen_evening_x_posts.py, run_x_posts.sh 等）は `fms-workspace/x-posts/` に移動済み

### データソースと注意点
- `docs/data/support_zones.geojson` — 県応援除雪の工区・期間・ステータス
- `docs/data/koku.geojson` — 市の除雪工区ステータス（最終除雪日、指令、更新日時）
- `docs/data/areas_meta.json` — 工区のcentroid座標・住所・地名。構造: `meta["areas"]["工区名"]["address_detail"]["quarter"]`
- FMSスプレッドシート（ユーザーが手動管理）: https://docs.google.com/spreadsheets/d/148iiDmslhzgn65nQCZG9Lk3Dobr7pEzkjBqcIK92aq0/
  - CSV export可能。FMS投稿の座標→工区マッチングに使える（背景調査用、投稿には直接使わない）

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

## 参考：他自治体の除雪マップ・システム

### 富山県 除雪機械運行管理システム（2026-02-16 メモ）
- URL: https://pubmap.toyama-josetsu.jp/josetsugps/imadoko/map_public/
- 富山県管理道路の除雪車稼働状況をリアルタイム表示
- 車両種別（グレーダー、トラック、ドーザ等）ごとの位置・走行軌跡を地図表示
- アニメーション再生で作業時間帯の移動を可視化
- 過去24時間の任意時点の状況を検索可能
- 技術: OpenLayers、KML形式で路線・消雪パイプ区間を管理
- 対象: 富山県全域（朝日町・黒部市等の複数市町村に対応）

### 北海道室蘭市 除雪ポータル（除雪しマース）（2026-02-16 メモ）
- URL: https://webapps-muroran.snow.maas-its.com/plan
- パナソニックITS開発のクラウド型除雪管理システム「除雪しマース」を採用
- 4つのアプリで構成: 管制アプリ（自治体向け）、住民向けWEB、除雪機械アプリ（オペレーター向け）、パトロールアプリ
- 除雪車のリアルタイム位置表示、出動計画の一斉送信、自動日報生成
- IVR（自動音声応答）による住民問い合わせ対応 → 電話対応業務91%削減の実績
- 2023年から実証実験開始
- 詳細: https://its.automotive.panasonic.com/maas/jyosetsu.html

### 青森市 除排雪状況の公開（デジ田甲子園 2022夏）（2026-02-17 メモ）
- URL: https://www.cas.go.jp/jp/seisaku/digitaldenen/menubook/2022_summer/0004.html
- 青森市が冬期間の除排雪作業の進捗状況をGoogleマップ上で公開するシステム
- 「作業予定あり」「作業中」「作業完了」の3段階で表示
- 令和2年度の豪雪で除排雪遅延→市民生活に支障が出たことへの対応として開発
- 令和3年度 約42万アクセス。電話・メール問い合わせ減少、職員負担軽減を実現
- リアルタイムで毎日情報更新

### 国土交通省東北地方整備局 雪みらい会津 論文 ka03（2026-02-18 メモ）
- URL: https://www.thr.mlit.go.jp/yukimirai_aizu/ronbun/ka03.pdf
- 出典: 国土交通省東北地方整備局「雪みらい会津」関連論文
- 作成: 2022年9月27日、全4ページ、日本語
- 内容: 会津地域を対象とした冬期道路状況に関する研究論文（詳細はPDF参照）

## Codex と協力する

Claude Code（このセッション）と OpenAI Codex（または他のAIコーディングアシスタント）を併用する場合の方針。

- **Claude Code** — メインの実装・リファクタリング・デバッグ・投稿素材生成
- **Codex / ChatGPT** — アルゴリズム設計の壁打ち、SQL/正規表現などのスニペット生成、第二意見
- 両者で生成したコードは必ずレビューしてからコミットする
- AI同士で矛盾する提案が出た場合はユーザーが判断する
- 作業ログは `tmp/session_YYYY-MM-DD.md` に随時記録する

## コミット時の注意

- gitignoreの変更が未コミットで残っていることがある
- bashでcdが効かない場合は `GIT_DIR` / `GIT_WORK_TREE` 環境変数で回避
