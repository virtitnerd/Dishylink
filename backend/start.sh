#!/usr/bin/env bash
# Starts the Starlink dashboard server in the background.
# Usage: ./start.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PID_FILE="server.pid"
LOG_FILE="server.log"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Already running (PID $(cat "$PID_FILE")). Run ./stop.sh first if you want to restart."
    exit 0
fi

if ! python3 -c "import fastapi, uvicorn" 2>/dev/null; then
    echo "Missing dependencies. Run this first:"
    echo "  python3 -m pip install -r requirements.txt"
    exit 1
fi

nohup python3 server.py > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "Starting Starlink dashboard (PID $!)..."
sleep 2

if curl -s -o /dev/null http://127.0.0.1:8787/; then
    echo "Running at http://127.0.0.1:8787"
else
    echo "Server may not have started -- check $LOG_FILE"
fi
