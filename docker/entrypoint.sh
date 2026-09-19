#!/bin/sh
set -eu

# Phase 0 spike: exact flag set is unverified against the real 4.10 Linux
# binary. Starting from the flags used across the SC2-AI ecosystem
# (python-sc2 / AI Arena) for headless listen mode; correct this once we
# see what the binary actually accepts (run with no args or -help first
# if this fails).

BASE_DIR="/root/StarCraftII/Versions/Base${SC2_BUILD}"
BINARY="${BASE_DIR}/SC2_x64"

if [ ! -x "$BINARY" ]; then
    echo "Expected SC2 binary not found at ${BINARY}" >&2
    echo "Contents of /root/StarCraftII/Versions:" >&2
    ls -la /root/StarCraftII/Versions >&2 || true
    exit 1
fi

exec "$BINARY" \
    -listen 0.0.0.0 \
    -port 5001 \
    -displayMode 0 \
    -dataDir /root/StarCraftII \
    -tempDir /tmp/sc2
