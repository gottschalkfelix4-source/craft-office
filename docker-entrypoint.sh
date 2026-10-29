#!/bin/sh
# Runs the portal as PUID:PGID (Unraid: 99:100, nobody:users) and makes /data theirs first, since
# Docker creates a missing host folder as root.
set -e
PUID="${PUID:-99}"
PGID="${PGID:-100}"
mkdir -p "$DATA_DIR"
if [ "$(stat -c %u:%g "$DATA_DIR")" != "$PUID:$PGID" ]; then
  echo "setting owner of $DATA_DIR to $PUID:$PGID"
  chown -R "$PUID:$PGID" "$DATA_DIR"
fi
exec su-exec "$PUID:$PGID" node /opt/portal/server.js "$@"
