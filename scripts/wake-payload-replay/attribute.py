#!/usr/bin/env python3
"""Attribute a trading mission's model-bound context, from the frozen dev db.

Answers three questions off `~/.t3/userdata/state.sqlite` and nothing else:
what filled the context window, which part of the biggest consumer filled it,
and what recurred unchanged between consecutive reads of the same tool.

    python3 scripts/wake-payload-replay/attribute.py <mission-id-prefix>

Quit the app first. Reading a live db gives a half-written mission.
"""
import json
import os
import sqlite3
import sys

DB = os.path.expanduser("~/.t3/userdata/state.sqlite")


def connect():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


def thread_for(con, mission_prefix):
    row = con.execute(
        "SELECT thread_id, mission_id FROM projection_trading_missions WHERE mission_id LIKE ?",
        (mission_prefix + "%",),
    ).fetchone()
    if row is None:
        sys.exit(f"no mission matching {mission_prefix!r}")
    return row


def tool_calls(con, thread_id):
    """Every completed tool call on the thread, with the text the model saw."""
    calls = []
    for payload, at in con.execute(
        "SELECT payload_json, created_at FROM projection_thread_activities "
        "WHERE thread_id = ? AND kind = 'tool.completed' ORDER BY created_at, rowid",
        (thread_id,),
    ):
        item = json.loads(payload).get("data", {}).get("item", {})
        text = "".join(c.get("text", "") for c in item.get("result", {}).get("content") or [])
        calls.append(
            {
                "tool": item.get("tool") or "?",
                "args": item.get("arguments"),
                "text": text,
                "chars": len(text),
                "at": at,
            }
        )
    return calls


def messages(con, thread_id):
    return list(
        con.execute(
            "SELECT role, text, created_at FROM projection_thread_messages "
            "WHERE thread_id = ? ORDER BY created_at, rowid",
            (thread_id,),
        )
    )


def sections(text):
    """Top-level keys of a JSON tool result, by encoded size."""
    try:
        obj = json.loads(text)
    except ValueError:
        return None
    if not isinstance(obj, dict):
        return None
    return {k: len(json.dumps(v, separators=(",", ":"))) for k, v in obj.items()}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    con = connect()
    thread_id, mission_id = thread_for(con, sys.argv[1])
    print(f"mission {mission_id}\nthread  {thread_id}\n")

    calls = tool_calls(con, thread_id)
    msgs = messages(con, thread_id)
    wake_chars = sum(len(t) for r, t, _ in msgs if r == "user")
    out_chars = sum(len(t) for r, t, _ in msgs if r == "assistant")

    by_tool = {}
    for call in calls:
        entry = by_tool.setdefault(call["tool"], {"n": 0, "chars": 0})
        entry["n"] += 1
        entry["chars"] += call["chars"]
    total = wake_chars + out_chars + sum(e["chars"] for e in by_tool.values())

    print("what filled the context")
    print(f"{'category':<28}{'n':>4}{'chars':>10}{'share':>8}")
    print("-" * 50)
    wakes = sum(1 for r, _, _ in msgs if r == "user")
    print(f"{'wake payloads':<28}{wakes:>4}{wake_chars:>10}{wake_chars / total * 100:>7.1f}%")
    for name, entry in sorted(by_tool.items(), key=lambda kv: -kv[1]["chars"]):
        share = entry["chars"] / total * 100
        print(f"{'tool: ' + name:<28}{entry['n']:>4}{entry['chars']:>10}{share:>7.1f}%")
    replies = sum(1 for r, _, _ in msgs if r == "assistant")
    print(f"{'model output':<28}{replies:>4}{out_chars:>10}{out_chars / total * 100:>7.1f}%")
    print("-" * 50)
    print(f"{'TOTAL':<28}{'':>4}{total:>10}")

    print("\nprovider-reported context window, one row per model call")
    print(f"{'#':>3}{'used':>9}{'input':>9}{'cached':>9}{'out':>7}")
    windows = [
        json.loads(p)
        for (p,) in con.execute(
            "SELECT payload_json FROM projection_thread_activities "
            "WHERE thread_id = ? AND kind = 'context-window.updated' ORDER BY created_at, rowid",
            (thread_id,),
        )
    ]
    for i, w in enumerate(windows):
        print(
            f"{i:>3}{w.get('usedTokens', 0):>9}{w.get('inputTokens', 0):>9}"
            f"{w.get('cachedInputTokens', 0):>9}{w.get('outputTokens', 0):>7}"
        )

    biggest = max(by_tool, key=lambda name: by_tool[name]["chars"])
    print(f"\ninside {biggest}, section by section")
    reads = [c for c in calls if c["tool"] == biggest]
    for i, call in enumerate(reads, 1):
        parts = sections(call["text"])
        print(f"\n  [{i}] {call['chars']} chars  args={json.dumps(call['args'])[:110]}")
        if parts is None:
            continue
        for key, size in sorted(parts.items(), key=lambda kv: -kv[1])[:8]:
            print(f"      {key:<28}{size:>8}{size / call['chars'] * 100:>7.1f}%")

    print(f"\nrecurring-identical between consecutive {biggest} reads")
    for i in range(1, len(reads)):
        try:
            before = json.loads(reads[i - 1]["text"])
            after = json.loads(reads[i]["text"])
        except ValueError:
            continue
        same = [
            (k, len(json.dumps(v, separators=(",", ":"), sort_keys=True)))
            for k, v in after.items()
            if json.dumps(before.get(k), separators=(",", ":"), sort_keys=True)
            == json.dumps(v, separators=(",", ":"), sort_keys=True)
        ]
        chars = sum(size for _, size in same)
        print(f"  [{i}]->[{i + 1}] {chars:>6} chars unchanged: {[k for k, _ in same]}")


if __name__ == "__main__":
    main()
