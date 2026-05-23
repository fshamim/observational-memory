#!/usr/bin/env python3
"""Validate a rebuilt OM hot session JSONL file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path, help="Path to the rebuilt hot session JSONL")
    parser.add_argument("--max-bytes", type=int, default=0, help="Optional max allowed file size")
    args = parser.parse_args()

    session_path = args.session
    if not session_path.exists():
        raise SystemExit(f"Session file not found: {session_path}")

    if args.max_bytes and session_path.stat().st_size > args.max_bytes:
        raise SystemExit(f"Session exceeds max bytes: {session_path.stat().st_size} > {args.max_bytes}")

    previous_id = None
    seen_header = False
    line_count = 0
    with session_path.open("r", encoding="utf-8", errors="strict") as handle:
        for line_no, line in enumerate(handle, start=1):
            raw = line.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
            except Exception as exc:
                raise SystemExit(f"Invalid JSON on line {line_no}: {exc}") from exc
            line_count += 1
            if line_count == 1:
                if entry.get("type") != "session":
                    raise SystemExit("First non-empty line must be a session header")
                seen_header = True
            else:
                parent_id = entry.get("parentId")
                if previous_id is not None and parent_id != previous_id:
                    raise SystemExit(
                        f"Broken parent chain on line {line_no}: expected parentId={previous_id!r}, got {parent_id!r}"
                    )
            previous_id = entry.get("id")

    if not seen_header:
        raise SystemExit("Missing session header")

    print(f"VALID: {session_path} ({line_count} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
