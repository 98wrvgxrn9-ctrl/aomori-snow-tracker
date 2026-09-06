#!/usr/bin/env python3
"""外部サイト由来のテキストを公開JSONへ書き出す前に無害化する共通ユーティリティ。

フロントエンドは表示時にHTMLエスケープを行うが、取得元サイトの改ざんや
仕様変更に備えて、パイプラインの入口でもHTMLタグ・制御文字を落としておく
（多層防御）。
"""

import re
import unicodedata

_TAG_RE = re.compile(r"<[^>]*>")

DEFAULT_MAX_LEN = 500


def clean_text(value, max_len=DEFAULT_MAX_LEN):
    """HTMLタグと制御文字を除去し、空白を正規化して長さを制限する。"""
    if value is None:
        return ""
    text = str(value)
    text = _TAG_RE.sub("", text)
    text = "".join(
        ch for ch in text
        if ch in "\n\t" or unicodedata.category(ch)[0] != "C"
    )
    text = re.sub(r"[ \t　]+", " ", text).strip()
    if max_len and len(text) > max_len:
        text = text[:max_len]
    return text


def clean_record(record, max_len=DEFAULT_MAX_LEN, skip_keys=()):
    """dict/list を再帰的に走査し、文字列値をすべて clean_text する。"""
    if isinstance(record, dict):
        return {
            k: (v if k in skip_keys else clean_record(v, max_len, skip_keys))
            for k, v in record.items()
        }
    if isinstance(record, list):
        return [clean_record(v, max_len, skip_keys) for v in record]
    if isinstance(record, str):
        return clean_text(record, max_len)
    return record
