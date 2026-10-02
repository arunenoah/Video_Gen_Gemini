#!/bin/sh
# Make sure the persistent data folder exists and is writable, then run the app as a non-root user.
set -e
DATA="${VIDEOGEN_DATA_DIR:-/var/data}"
mkdir -p "$DATA"
if [ "$(id -u)" = "0" ]; then
  # Disks are usually mounted root-owned. Only re-own when needed so a big existing disk isn't walked on every start.
  [ "$(stat -c %u "$DATA")" = "10001" ] || chown -R 10001:10001 "$DATA"
  exec setpriv --reuid=10001 --regid=10001 --init-groups python /app/server.py
fi
exec python /app/server.py
