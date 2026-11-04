#!/bin/sh
# Zalozi issue s labelem factory a pocka na PR. Pouziti: tests/e2e.sh [titulek]
set -eu
cd "$(dirname "$0")/.."
T=$(grep '^FORGEJO_ADMIN_TOKEN' orchestrator/.env | cut -d= -f2)
U=http://${FACTORY_BIND:-127.0.0.1}:3000/api/v1/repos/factory-admin/fixture
c() { curl -fsS -H "Authorization: token $T" -H "Content-Type: application/json" "$@"; }
L=$(c $U/labels | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
N=$(c $U/issues -d "{\"title\":\"${1:-E2E task}\",\"body\":\"hello\",\"labels\":[$L]}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["number"])')
s=$(date +%s)
while [ $(( $(date +%s) - s )) -lt 180 ]; do
  r=$(c $U/issues/$N/comments | python3 -c 'import sys,json;print(*[x["body"] for x in json.load(sys.stdin)])')
  [ -n "$r" ] && { echo "issue #$N za $(( $(date +%s) - s )) s: $r"; case "$r" in PR:*) exit 0;; *) exit 1;; esac; }
  sleep 1
done
echo "issue #$N: timeout"; exit 1
