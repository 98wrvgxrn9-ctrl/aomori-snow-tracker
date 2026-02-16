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

## コミット時の注意

- gitignoreの変更が未コミットで残っていることがある
- bashでcdが効かない場合は `GIT_DIR` / `GIT_WORK_TREE` 環境変数で回避
