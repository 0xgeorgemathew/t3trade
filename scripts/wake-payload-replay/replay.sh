#!/bin/bash
# Replay recorded trading turns through the real CLIs, full payload vs reduced.
#
# NOT a test. Nothing runs this automatically — it spends provider tokens and
# needs both CLIs signed in. See README.md for cost and coverage.
#
#   TURNS="2 3 4" ARMS="full reduced" ./replay.sh <scenario-dir> <out-dir>
#
# Reads <scenario-dir>/t<turn>.<arm>.txt and writes one JSON decision per run
# to <out-dir>/t<turn>.<arm>.<model>.json. An existing non-empty result is
# skipped, so a killed run resumes where it stopped.
set -u
SCEN="${1:?usage: replay.sh <scenario-dir> <out-dir>}"
OUT="${2:?usage: replay.sh <scenario-dir> <out-dir>}"
TURNS="${TURNS:-2 3 4 5 6 7 8}"
ARMS="${ARMS:-full reduced}"
MODELS="${MODELS:-codex claude}"
mkdir -p "$OUT"

# The Claude CLI is commonly pointed at a third-party gateway through
# ANTHROPIC_BASE_URL and the ANTHROPIC_DEFAULT_*_MODEL overrides. A replay that
# silently ran on a different model would prove nothing, so they are cleared.
run_claude() {
  env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY \
      -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_OPUS_MODEL \
      -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID \
      claude -p --model claude-sonnet-5 --effort low
}

run_codex() {
  codex exec -m gpt-5.6-luna -c model_reasoning_effort=low \
        --sandbox read-only --skip-git-repo-check -
}

for turn in $TURNS; do
  for arm in $ARMS; do
    prompt="$SCEN/t$turn.$arm.txt"
    [ -f "$prompt" ] || continue
    for model in $MODELS; do
      result="$OUT/t$turn.$arm.$model.json"
      [ -s "$result" ] && continue
      echo "=== turn $turn / $arm / $model"
      "run_$model" < "$prompt" 2>/dev/null | grep -o '{"action".*}' | tail -1 > "$result"
      echo "  $(cat "$result")"
    done
  done
done
