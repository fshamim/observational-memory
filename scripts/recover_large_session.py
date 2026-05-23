#!/usr/bin/env python3
"""Recover a large Pi session into a compact OM hot session.

This is an offline recovery helper for already-bloated sessions such as ghostclaw-main.
It stream-reads the source file, keeps the latest metadata, cuts at a safe cursor-derived
boundary, trims oversized tool-result payloads, writes a compact hot session, and archives
removed history into chunk files under `.pi/om/raw/...`.
"""

from __future__ import annotations

import argparse
import json
import shutil
from collections import deque
from pathlib import Path
from typing import Any


def iter_entries(session_path: Path):
    with session_path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            raw = line.strip()
            if not raw:
                continue
            try:
                entry = json.loads(raw)
            except Exception:
                continue
            yield entry


def get_message_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [entry for entry in entries if entry.get("type") == "message" and isinstance(entry.get("message"), dict)]


def normalize_call_id_variants(raw_id: str) -> list[str]:
    trimmed = raw_id.strip()
    if not trimmed:
        return []
    variants = [trimmed]
    if "|" in trimmed:
        variants.append(trimmed.split("|", 1)[0])
    return list(dict.fromkeys(variants))


def extract_assistant_tool_call_ids(message_entry: dict[str, Any]) -> list[str]:
    message = message_entry.get("message") or {}
    if message.get("role") != "assistant":
        return []
    content = message.get("content")
    if not isinstance(content, list):
        return []
    ids: list[str] = []
    for part in content:
        if isinstance(part, dict) and part.get("type") == "toolCall":
            raw_id = str(part.get("id") or "").strip()
            ids.extend(normalize_call_id_variants(raw_id))
    return list(dict.fromkeys([value for value in ids if value]))


def extract_tool_result_call_id(message_entry: dict[str, Any]) -> str | None:
    message = message_entry.get("message") or {}
    if message.get("role") != "toolResult":
        return None
    for key in ("toolCallId", "tool_call_id", "callId", "call_id"):
        raw = message.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def align_cursor_to_tool_pairs(message_entries: list[dict[str, Any]], candidate_index: int) -> int:
    bounded = max(0, min(candidate_index, len(message_entries)))
    call_positions: dict[str, int] = {}
    for index, entry in enumerate(message_entries):
        for tool_call_id in extract_assistant_tool_call_ids(entry):
            call_positions.setdefault(tool_call_id, index)

    safe_index = bounded
    while safe_index > 0:
        next_safe_index = safe_index
        for index in range(safe_index, len(message_entries)):
            tool_result_call_id = extract_tool_result_call_id(message_entries[index])
            if not tool_result_call_id:
                continue
            call_index = None
            for variant in normalize_call_id_variants(tool_result_call_id):
                if variant in call_positions:
                    call_index = call_positions[variant]
                    break
            if call_index is not None and call_index < safe_index:
                next_safe_index = call_index
                break
        if next_safe_index == safe_index:
            break
        safe_index = next_safe_index
    return safe_index


def get_latest(entries: list[dict[str, Any]], predicate):
    for entry in reversed(entries):
        if predicate(entry):
            return entry
    return None


def trim_large_message_entry(entry: dict[str, Any], preview_chars: int) -> tuple[dict[str, Any], bool]:
    encoded = json.dumps(entry, ensure_ascii=False)
    if len(encoded.encode("utf-8")) <= 8 * 1024 * 1024:
        return json.loads(encoded), False
    next_entry = json.loads(encoded)
    message = next_entry.get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        message["content"] = content[:preview_chars] + "\n...[trimmed during OM session recovery]"
    elif isinstance(content, list):
        replaced = False
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text" and not replaced:
                part["text"] = str(part.get("text", ""))[:preview_chars] + "\n...[trimmed during OM session recovery]"
                replaced = True
            elif isinstance(part, dict) and part.get("type") == "text":
                part["text"] = ""
    details = message.get("details")
    if isinstance(details, dict) and isinstance(details.get("state"), dict):
        state = details["state"]
        details["state"] = {
            "workflowId": state.get("workflowId"),
            "activeSprintName": state.get("activeSprintName"),
            "phase": state.get("phase"),
            "latestMaxSeverity": state.get("latestMaxSeverity"),
            "pendingGate": state.get("pendingGate"),
            "updatedAt": state.get("updatedAt"),
            "trimmedByOm": True,
        }
    return next_entry, True


def write_jsonl(entries: list[dict[str, Any]], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    tmp.replace(path)


def write_archive_chunks(entries: list[dict[str, Any]], archive_dir: Path, chunk_bytes: int) -> list[str]:
    archive_dir.mkdir(parents=True, exist_ok=True)
    current: list[dict[str, Any]] = []
    current_bytes = 0
    chunk_index = 1
    chunk_paths: list[str] = []

    def flush() -> None:
        nonlocal current, current_bytes, chunk_index
        if not current:
            return
        chunk_path = archive_dir / f"chunk-{chunk_index:06d}.jsonl"
        write_jsonl(current, chunk_path)
        chunk_paths.append(str(chunk_path))
        chunk_index += 1
        current = []
        current_bytes = 0

    for entry in entries:
        entry_bytes = len((json.dumps(entry, ensure_ascii=False) + "\n").encode("utf-8"))
        if current and current_bytes + entry_bytes > chunk_bytes:
            flush()
        current.append(entry)
        current_bytes += entry_bytes
    flush()
    return chunk_paths


def recover_session(source: Path, output: Path, archive_dir: Path, keep_name: str | None, preview_chars: int, chunk_bytes: int) -> dict[str, Any]:
    entries = list(iter_entries(source))
    if not entries:
        raise SystemExit(f"No valid entries found in {source}")

    header = next((entry for entry in entries if entry.get("type") == "session"), None) or {}
    latest_state = get_latest(entries, lambda entry: entry.get("type") == "custom" and entry.get("customType") == "om:state")
    latest_session_info = get_latest(entries, lambda entry: entry.get("type") == "session_info")
    latest_model = get_latest(entries, lambda entry: entry.get("type") == "model_change")
    latest_thinking = get_latest(entries, lambda entry: entry.get("type") == "thinking_level_change")

    latest_state_payload = (((latest_state or {}).get("data") or {}).get("state") or {})
    cursor = latest_state_payload.get("rawMessageCursor", latest_state_payload.get("lastObservedMessageIndex"))
    cursor = int(cursor or 0)

    message_entries = get_message_entries(entries)
    safe_start = align_cursor_to_tool_pairs(message_entries, cursor)
    archived_entries = message_entries[:safe_start]
    kept_entries = []
    trimmed_ids: list[str] = []
    for entry in message_entries[safe_start:]:
        trimmed_entry, trimmed = trim_large_message_entry(entry, preview_chars)
        kept_entries.append(trimmed_entry)
        if trimmed and entry.get("id"):
            trimmed_ids.append(str(entry.get("id")))

    archive_paths = write_archive_chunks(archived_entries, archive_dir, chunk_bytes)

    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    new_header = {
        "type": "session",
        "version": header.get("version", 3),
        "id": f"{header.get('id', 'om-hot')}-{int(__import__('time').time())}",
        "timestamp": now,
        "cwd": header.get("cwd") or str(source.parent),
        "parentSession": str(source),
    }

    out_entries: list[dict[str, Any]] = [new_header]
    parent_id = new_header["id"]

    for metadata in [latest_session_info, latest_model, latest_thinking]:
        if not metadata:
            continue
        next_entry = json.loads(json.dumps(metadata))
        if next_entry.get("type") == "session_info" and keep_name:
            next_entry["name"] = keep_name
        next_entry["parentId"] = parent_id
        out_entries.append(next_entry)
        parent_id = next_entry.get("id", parent_id)

    if latest_state:
        state_entry = json.loads(json.dumps(latest_state))
        state_payload = (((state_entry.get("data") or {}).get("state")) or {})
        state_payload["rawMessageCursor"] = 0
        state_payload["lastObservedMessageIndex"] = 0
        state_entry["parentId"] = parent_id
        out_entries.append(state_entry)
        parent_id = state_entry.get("id", parent_id)

    rollover = {
        "type": "custom",
        "id": f"om-rollover-{int(__import__('time').time())}",
        "timestamp": now,
        "customType": "om:rollover",
        "data": {
            "version": 1,
            "token": "offline-recovery",
            "reason": "legacy-recovery",
            "createdAt": now,
            "sourceSessionPath": str(source),
            "targetSessionPath": str(output),
            "sessionName": keep_name or (latest_session_info or {}).get("name") or source.stem,
            "coveredEntryIds": [entry.get("id") for entry in archived_entries if entry.get("id")],
            "trimmedEntryIds": trimmed_ids,
            "archiveChunks": [{"path": p} for p in archive_paths],
            "cleanupOriginalSessionPath": str(source),
        },
    }
    rollover["parentId"] = parent_id
    out_entries.append(rollover)
    parent_id = rollover["id"]

    for entry in kept_entries:
        next_entry = json.loads(json.dumps(entry))
        next_entry["parentId"] = parent_id
        out_entries.append(next_entry)
        parent_id = next_entry.get("id", parent_id)

    write_jsonl(out_entries, output)
    return {
        "source": str(source),
        "output": str(output),
        "archive_dir": str(archive_dir),
        "archive_chunks": archive_paths,
        "trimmedEntryIds": trimmed_ids,
        "coveredMessageCount": len(archived_entries),
        "retainedMessageCount": len(kept_entries),
        "outputBytes": output.stat().st_size,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path, help="Large source session JSONL")
    parser.add_argument("--output", type=Path, required=True, help="Recovered hot session output path")
    parser.add_argument("--archive-dir", type=Path, required=True, help="Archive chunk directory")
    parser.add_argument("--report", type=Path, default=None, help="Optional JSON report output path")
    parser.add_argument("--name", type=str, default="", help="Optional preserved session name")
    parser.add_argument("--preview-chars", type=int, default=1500, help="Preview chars kept in trimmed entries")
    parser.add_argument("--chunk-bytes", type=int, default=64 * 1024 * 1024, help="Archive chunk target bytes")
    parser.add_argument("--move-source", action="store_true", help="Move source session out of active session scanning into archive-dir/original.jsonl")
    args = parser.parse_args()

    report = recover_session(args.session, args.output, args.archive_dir, args.name or None, args.preview_chars, args.chunk_bytes)
    if args.move_source:
        target = args.archive_dir / f"source-original-{args.session.name}"
        target.parent.mkdir(parents=True, exist_ok=True)
        counter = 1
        while target.exists():
            target = args.archive_dir / f"source-original-{args.session.name}.{counter}"
            counter += 1
        shutil.move(str(args.session), str(target))
        report["movedSourceTo"] = str(target)

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
