#!/bin/bash
# Placeholder solution entrypoint — candidate/scaffold stub.
# Exits 0 so the harness proceeds to tests/test.sh; the smoke check only verifies
# that the harness executes end-to-end, not that the reward is >= 1.0.
set -e
cd /app/distribution-gateway
npm run start &
GATEWAY_PID=$!

until curl -s http://localhost:7070 > /dev/null; do
    sleep 1
done
cd /app
npm run report

PUBLISHER_EXIT=$?

kill $GATEWAY_PID 2>/dev/null || true
# The reference publisher (publisher/release-publisher.mjs) is authored and graded
# separately by a human; no solution is included in this folder.
exit $PUBLISHER_EXIT
