#!/bin/bash
# Start the Telegram bot, replacing any running instance.
cd "$(dirname "$0")"

# Kill existing process via PID file if present
if [ -f bot.pid ]; then
  OLD_PID=$(cat bot.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing bot (PID $OLD_PID)..."
    kill "$OLD_PID"
    sleep 1
  fi
  rm -f bot.pid
fi

nohup node index.js >> bot.log 2>&1 &
echo "Bot started (PID $!)"
