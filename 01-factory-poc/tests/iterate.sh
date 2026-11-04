#!/bin/sh
# Issue -> PR, pak commit do main a komentar /factory v PR. Overi iteraci pres staging vcetne rebase na novy main.
# Pouziti: tests/iterate.sh [titulek]. Orchestrator musi bezet.
set -eu
cd "$(dirname "$0")/.."
T=$(grep '^FORGEJO_ADMIN_TOKEN' orchestrator/.env | cut -d= -f2)
U=http://${FACTORY_BIND:-127.0.0.1}:3000/api/v1/repos/factory-admin/fixture
c() { curl -fsS -H "Authorization: token $T" -H "Content-Type: application/json" "$@"; }
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
wait_for() { # popis, pocet komentaru, ktery se ma na issue/PR objevit
  s=$(date +%s)
  while [ $(( $(date +%s) - s )) -lt 120 ]; do
    n=$(c $U/issues/$1/comments | j 'len(d)')
    [ "$n" -ge "$2" ] && return 0
    sleep 1
  done
  echo "timeout: $1 ma mene nez $2 komentaru"; exit 1
}
L=$(c $U/labels | j 'd[0]["id"]')
N=$(c $U/issues -d "{\"title\":\"${1:-Iterate task}\",\"body\":\"hello\",\"labels\":[$L]}" | j 'd["number"]')
wait_for $N 1
PR=$(c $U/issues/$N/comments | j 'd[0]["body"].split("#")[1]')
echo "issue #$N -> PR #$PR"
C1=$(c $U/pulls/$PR | j 'd["head"]["sha"]')
# Posun main, aby iterace musela udelat skutecny rebase.
F="rebase-probe-$(date +%s).txt"
c $U/contents/$F -d "{\"content\":\"$(printf probe | base64)\",\"message\":\"probe $F\",\"branch\":\"main\"}" >/dev/null
MAIN=$(c $U/branches/main | j 'd["commit"]["id"]')
c $U/issues/$PR/comments -d '{"body":"/factory pokracuj"}' >/dev/null
wait_for $PR 2
# Forgejo dopocitava merge_base po pushi asynchronne.
s=$(date +%s)
while :; do
  MB=$(c $U/pulls/$PR | j 'd["merge_base"]')
  [ "$MB" = "$MAIN" ] || [ $(( $(date +%s) - s )) -ge 30 ] && break
  sleep 1
done
C2=$(c $U/pulls/$PR | j 'd["head"]["sha"]')
echo "main=$MAIN merge_base=$MB head: $C1 -> $C2"
[ "$MB" = "$MAIN" ] && [ "$C1" != "$C2" ] && { echo "OK: iterace prepsala vetev a PR je na novem mainu"; exit 0; }
echo "FAIL"; exit 1
