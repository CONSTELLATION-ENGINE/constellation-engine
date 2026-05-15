#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# long-task-runner.sh — fire-and-forget wrapper for long-running tasks.
# Spawns COMMAND in the background, returns immediately with PID + log path,
# and sends a Telegram notification on completion (success or failure).
#
# Usage:
#   scripts/long-task-runner.sh <label> <command...>
#
# Example:
#   scripts/long-task-runner.sh noise-audit node scripts/experiments/noise-audit.js
#
# Output (printed before returning):
#   [long-task-runner] label=<label> pid=<pid> log=<path>
#
# Env overrides (optional):
#   LTR_LOG_DIR   default /tmp
#   LTR_QUIET     if set, no Telegram notification (just background + log)

set -u

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <label> <command...>" >&2
  exit 2
fi

LABEL="$1"; shift
LOG_DIR="${LTR_LOG_DIR:-/tmp}"
TS="$(date +%Y%m%d-%H%M%S)"
SAFE_LABEL="$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '_')"
LOG="$LOG_DIR/long-task-${SAFE_LABEL}-${TS}.log"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$REPO_ROOT/config.json"

# Pull Telegram creds from .env (optional — runner still works without them).
TG_TOKEN=""
TG_CHAT=""
if [ -z "${LTR_QUIET:-}" ]; then
  ENGINE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ -f "$ENGINE_ROOT/.env" ]; then
    # shellcheck disable=SC1091
    set -a && source "$ENGINE_ROOT/.env" && set +a
  fi
  TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  TG_CHAT="${OWNER_USER_ID:-}"
fi

CMD_DISPLAY="$*"

# Inner runner: executes the command, captures exit code, sends Telegram.
# Detached via setsid + nohup so it survives the parent shell exiting.
(
  setsid bash -c '
    set +e
    LABEL="$1"; LOG="$2"; TG_TOKEN="$3"; TG_CHAT="$4"; CMD_DISPLAY="$5"
    shift 5
    START_EPOCH=$(date +%s)
    {
      echo "[long-task-runner] label=$LABEL"
      echo "[long-task-runner] started=$(date -Iseconds)"
      echo "[long-task-runner] cmd=$CMD_DISPLAY"
      echo "[long-task-runner] ----"
    } >> "$LOG" 2>&1
    "$@" >> "$LOG" 2>&1
    EC=$?
    END_EPOCH=$(date +%s)
    DUR=$((END_EPOCH - START_EPOCH))
    {
      echo "[long-task-runner] ----"
      echo "[long-task-runner] finished=$(date -Iseconds) exit=$EC duration_s=$DUR"
    } >> "$LOG" 2>&1
    if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
      if [ "$EC" -eq 0 ]; then STATUS="✅ done"; else STATUS="❌ exit=$EC"; fi
      TAIL=$(tail -n 20 "$LOG" 2>/dev/null | sed "s/[<>&]//g")
      MSG="🔔 long-task: $LABEL
$STATUS  duration=${DUR}s
log: $LOG

--- tail ---
$TAIL"
      curl -sS --max-time 15 \
        -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TG_CHAT}" \
        --data-urlencode "text=${MSG}" \
        >/dev/null 2>&1 || true
    fi
  ' _ "$LABEL" "$LOG" "$TG_TOKEN" "$TG_CHAT" "$CMD_DISPLAY" "$@" </dev/null >/dev/null 2>&1 &
) &
disown 2>/dev/null || true

# Best-effort PID for the foreground display: capture the immediate child.
# (The actual task PID is inside setsid; the log records its own metadata.)
sleep 0.2
PID="$!"

echo "[long-task-runner] label=$LABEL pid=$PID log=$LOG"
if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
  echo "[long-task-runner] telegram=enabled chat_id=$TG_CHAT"
else
  echo "[long-task-runner] telegram=disabled"
fi
exit 0
