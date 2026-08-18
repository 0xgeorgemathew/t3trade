#!/usr/bin/env python3
"""Build replay scenarios from a real mission: wake + tool result + the decision.

Each scenario is one turn of a recorded mission, rendered as a single prompt a
CLI can be handed: the mandate, the tool contracts, the wake the run received,
the `trading_look` result it read, and a request for the decision as JSON.

    python3 scripts/wake-payload-replay/build-scenarios.py <mission-id-prefix> <out-dir>

Writes `<out-dir>/t<turn>.full.txt` and a `truth.json` naming what the run
actually did that turn. Reduce the payloads yourself and write
`t<turn>.<arm>.txt` beside them; `replay.sh` runs whatever arms it finds.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from attribute import connect, messages, thread_for, tool_calls  # noqa: E402

TOOLS = """You have these tools (`trading_look` is already called — its result is below):
- trading_plan(strategy): publish market, intent (long|short|stand_aside), entry, stop, target,
  invalidation, reassess, projection {direction, price, byMinutes, invalidationPrice}, because.
- trading_watch(condition|cancel): arm ONE condition — price (a level; confirm "close" needs an
  interval, else touch), metric, pnl, giveback, fill, time — or retire one by id.
- trading_enter(market, side, stopPrice, notionalUsd?, urgency?): the server derives the limit,
  the size and the protection.
- trading_exit(action): close | reduce | cancel_order | move_stop.
- trading_strategy(name): read a playbook.
"""

ASK = """Decide this turn. Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter|exit|plan_only|stand_aside|hold","direction":"long|short|none",
 "entryTrigger":<number|null>,"stop":<number|null>,"target":<number|null>,
 "notionalUsd":<number|null>,"reason":"<one line>"}
"action" is what you would do THIS turn: "enter" only if you would call trading_enter now,
"exit" only if you would close or reduce now, "hold" if you hold a position unchanged,
"plan_only" if you publish a setup and wait, "stand_aside" if there is no setup."""


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    prefix, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    con = connect()
    thread_id, _ = thread_for(con, prefix)
    msgs = messages(con, thread_id)
    calls = tool_calls(con, thread_id)

    wakes = [(t, at) for r, t, at in msgs if r == "user"]
    replies = [t for r, t, _ in msgs if r == "assistant"]
    mandate = json.loads(wakes[0][0])["instruction"]

    truth = {}
    # Turn 1 is the bootstrap wake, which is a different shape and has no
    # preceding state to reduce. Replay starts at the first woken turn.
    for turn, (wake, wake_at) in enumerate(wakes[1:], start=2):
        after = [c for c in calls if c["tool"] == "trading_look" and c["at"] >= wake_at]
        if not after:
            continue
        look = after[0]["text"]
        prompt = (
            "You are an autonomous perpetual-futures trading agent.\n\n"
            f"YOUR MANDATE:\n{mandate}\n\n{TOOLS}\n"
            f"WAKE MESSAGE:\n{wake}\n\nRESULT OF trading_look:\n{look}\n\n{ASK}\n"
        )
        path = os.path.join(out_dir, f"t{turn}.full.txt")
        with open(path, "w") as handle:
            handle.write(prompt)
        truth[str(turn)] = replies[turn - 1] if turn - 1 < len(replies) else ""
        print(f"t{turn}  {len(prompt):>7} chars  -> {path}")

    with open(os.path.join(out_dir, "truth.json"), "w") as handle:
        json.dump(truth, handle, indent=1)


if __name__ == "__main__":
    main()
