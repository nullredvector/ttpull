#!/bin/sh
# Start a virtual display for headed Chromium, then the server.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99

# Wait until the display answers (up to ~10s)
i=0
while [ $i -lt 50 ]; do
  [ -S /tmp/.X11-unix/X99 ] && break
  i=$((i + 1))
  sleep 0.2
done

exec node server.js
