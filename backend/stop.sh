#!/usr/bin/env bash
# Stops the Starlink dashboard server started by start.sh.
# Usage: ./stop.sh
cd "$(dirname "${BASH_SOURCE[0]}")"
PID_FILE="server.pid"

if [[ -f "$PID_FILE" ]]; then
    target_pid="$(cat "$PID_FILE")"
    if kill -0 "$target_pid" 2>/dev/null; then
        kill "$target_pid"
        echo "Stopped PID $target_pid"
    else
        echo "PID $target_pid not running."
    fi
    rm -f "$PID_FILE"
else
    echo "No server.pid found -- nothing to stop (or it wasn't started with start.sh)."
fi
