#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Generate extension/stocks.json from AKShare's Eastmoney A-share listing.

Usage:
  pip install akshare pandas
  python tools/build_stocks_from_akshare.py

Outputs:
  extension/stocks.json  # [{ code, name, market }]
"""

import json
import sys
from pathlib import Path


def main() -> int:
    try:
        import akshare as ak  # type: ignore
    except Exception as e:
        sys.stderr.write(
            "AKShare not installed. Please run: pip install akshare pandas\n"
        )
        return 2

    # Fetch spot data for all A-shares from Eastmoney via AKShare
    df = ak.stock_zh_a_spot_em()

    # Expect Chinese headers like: 代码, 名称
    code_col = None
    name_col = None
    for col in df.columns:
        if str(col).strip() in ("代码", "code", "证券代码"):
            code_col = col
        if str(col).strip() in ("名称", "name", "证券简称"):
            name_col = col
    if code_col is None or name_col is None:
        raise RuntimeError(f"Unexpected columns: {list(df.columns)}")

    items = []
    for _, row in df.iterrows():
        code = str(row[code_col]).strip()
        name = str(row[name_col]).strip()
        if not code or len(code) != 6 or not code.isdigit():
            continue
        market = "sh" if code.startswith("6") else "sz"
        items.append({"code": code, "name": name, "market": market})

    # De-duplicate by market+code and sort
    uniq = {}
    for it in items:
        uniq[f"{it['market']}{it['code']}"] = it
    out_list = list(uniq.values())
    out_list.sort(key=lambda x: (x["market"], x["code"]))

    # Write to extension/stocks.json
    out_path = Path(__file__).resolve().parents[1] / "extension" / "stocks.json"
    out_path.write_text(json.dumps(out_list, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(out_list)} symbols to {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

