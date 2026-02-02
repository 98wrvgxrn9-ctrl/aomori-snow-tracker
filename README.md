# aomori-snow-tracker

青森市除排雪出動指令状況の履歴記録

## 概要

[あおもりSNOW情報](https://google.com/maps/d/viewer?mid=1Ydi7GSvJ_4zOLatVL_FOUMwoZdTN-_8)のデータを1時間ごとに取得・記録します。

## データ

- `data/history.csv` - 全履歴（追記形式）
- `data/YYYYMMDD_HHMMSS.json` - 時点スナップショット

## ステータス

| 色 | ステータス |
|----|------------|
| 赤 | 作業中 |
| 青 | 現場確認中 |
| 黄 | 作業予定あり |

## 手動実行

```bash
pip install -r requirements.txt
python scripts/fetch_kml.py
```
## Note
- 実験的実装を含みます
- 本番運用前のプロトタイプです
