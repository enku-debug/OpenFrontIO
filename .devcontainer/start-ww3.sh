#!/usr/bin/env bash
# Starts the WW3 dev server (client on :9000 + game server) in the
# background for GitHub Codespaces, unless it is already running.
#   start-ww3.sh           start if needed (postStartCommand)
#   start-ww3.sh --follow  start if needed, then show the log (postAttachCommand)
# Log: /tmp/ww3-dev.log
set -u
LOG=/tmp/ww3-dev.log
cd "$(dirname "$0")/.." || exit 1

running() {
  pgrep -x -f "npm run dev" >/dev/null ||
    (exec 3<>/dev/tcp/127.0.0.1/9000) 2>/dev/null
}

if running; then
  echo "WW3 is already running."
else
  echo "Starting WW3..."
  # setsid -f: detach into its own session right away, so the process
  # survives when the lifecycle command or terminal that launched it ends.
  setsid -f nohup npm run dev >"$LOG" 2>&1 </dev/null
  sleep 2
fi

if [ "${1:-}" = "--follow" ]; then
  exec tail -n 40 -F "$LOG"
fi
