#!/bin/bash
# usage: run.sh script.mjs [args]  (runs in own container e2b-run-*, host network, reads stdin)
D=$(cd "$(dirname "$0")" && pwd)
. $D/stack/.env
f=$1; shift
Q=$(printf '%q ' "$@")
exec sg docker -c "docker run --rm -i --name e2b-run-$$ --network host --env-file $D/state/sdk.env -e E2B_API_URL=http://127.0.0.1:13000 -e E2B_SANDBOX_URL=http://127.0.0.1:3002 -v $D/js:/app/js:ro -w /app --entrypoint node $E2B_NODE_E2B_IMAGE /app/js/$f $Q"
