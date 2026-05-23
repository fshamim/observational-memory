#!/usr/bin/env python3
"""Stream-report a Pi session JSONL file for OM recovery planning."""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any


def iter_entries(session_path: Path):
    with session_path.open("r", encoding="utf-8", errors="replace") as handle:
        for index, line in enumerate(handle):
            raw = line.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
            except Exception:
                continue
            yield index, entry, len(line.encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path, help="Path to the session JSONL file")
    args = parser.parse_args()

    session_path = args.session
    if not session_path.exists():
        raise SystemExit(f"Session file not found: {session_path}")

    total_bytes = session_path.stat().st_size
    type_bytes: Counter[str] = Counter()
    custom_bytes: Counter[str] = Counter()
    type_counts: Counter[str] = Counter()
    custom_counts: Counter[str] = Counter()
    largest: list[tuple[int, int, str, str]] = []
    latest_state: dict[str, Any] | None = None
    session_name = ""
    message_count = 0

    for index, entry, line_bytes in iter_entries(session_path):
        entry_type = str(entry.get("type", "unknown"))
        type_bytes[entry_type] += line_bytes
        type_counts[entry_type] += 1
        if entry_type == "custom":
            custom_type = str(entry.get("customType", "unknown"))
            custom_bytes[custom_type] += line_bytes
            custom_counts[custom_type] += 1
            if custom_type == "om:state":
                latest_state = entry
        elif entry_type == "session_info" and isinstance(entry.get("name"), str):
            session_name = entry["name"]
        elif entry_type == "message":
            message_count += 1

        largest.append((line_bytes, index, entry_type, str(entry.get("id", ""))))
        largest.sort(reverse=True)
        largest[:] = largest[:10]

    latest_state_payload = (((latest_state or {}).get("data") or {}).get("state") or {})
    latest_cursor = latest_state_payload.get("rawMessageCursor", latest_state_payload.get("lastObservedMessageIndex"))

    print(f"Session: {session_path}")
    print(f"Name: {session_name or '(unnamed)'}")
    print(f"Total size: {total_bytes / 1024 / 1024:.2f} MiB")
    print(f"Message count: {message_count}")
    print(f"Latest OM cursor: {latest_cursor if latest_cursor is not None else 'n/a'}")
    print()
    print("Bytes by type:")
    for key, value in type_bytes.most_common():
        print(f"  {key:<20} {value / 1024 / 1024:8.2f} MiB  ({type_counts[key]} entries)")
    if custom_bytes:
        print()
        print("Bytes by customType:")
        for key, value in custom_bytes.most_common():
            print(f"  {key:<20} {value / 1024 / 1024:8.2f} MiB  ({custom_counts[key]} entries)")
    if largest:
        print()
        print("Largest entries:")
        for line_bytes, index, entry_type, entry_id in largest:
            print(f"  line={index:<6} type={entry_type:<18} bytes={line_bytes:<12} id={entry_id}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
