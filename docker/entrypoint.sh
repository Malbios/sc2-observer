#!/bin/bash
set -u

# Runs one SC2 client, or two for a game between two bots (SC2_CLIENTS=2).
# Client 1 listens on 5001 and client 2 on 5002. They have to share this
# container: bots never set host_ip, so the two clients meet on localhost,
# and two containers on a Docker network hung at join_game (CLAUDE.md,
# "Two-player facts").
#
# The container ends as soon as either client does. A dead client hangs the
# other side's game forever with no error, and with a second process the
# container would otherwise still read "Up", so stopping is what makes a dead
# client visible to the app.

BASE_DIR="/root/StarCraftII/Versions/Base${SC2_BUILD}"
BINARY="${BASE_DIR}/SC2_x64"
CLIENTS="${SC2_CLIENTS:-1}"

if [ ! -x "$BINARY" ]; then
    echo "Expected SC2 binary not found at ${BINARY}" >&2
    echo "Contents of /root/StarCraftII/Versions:" >&2
    ls -la /root/StarCraftII/Versions >&2 || true
    exit 1
fi

start_client() {
    # Each client needs its own temp dir; the data dir is shared.
    "$BINARY" \
        -listen 0.0.0.0 \
        -port "$1" \
        -displayMode 0 \
        -dataDir /root/StarCraftII \
        -tempDir "/tmp/sc2-$1" &
}

# bash is PID 1 now, and PID 1 ignores SIGTERM unless it says otherwise.
trap 'kill $(jobs -p) 2>/dev/null; exit 143' TERM INT

start_client 5001
if [ "$CLIENTS" = "2" ]; then
    # One after the other, as python-sc2 does on Linux.
    sleep 5
    start_client 5002
fi

wait -n
status=$?
echo "an SC2 client exited (status ${status}); stopping the container" >&2
kill $(jobs -p) 2>/dev/null
exit "$status"
