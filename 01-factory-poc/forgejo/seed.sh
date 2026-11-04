#!/bin/sh
# Jednorazovy seed: uzivatele, token bota, demo repo, label, webhook.
set -eu
cd "$(dirname "$0")/.."
U=http://${FACTORY_BIND:-127.0.0.1}:3000/api/v1
fj() { docker exec -u 1000 factory-forgejo-forgejo-1 forgejo "$@"; }
env=orchestrator/.env
[ -f "$env" ] && { grep -q '^YFACTORY_PASSWORD=' "$env" || printf 'YFACTORY_PASSWORD=%s\n' "$(openssl rand -hex 16)" >> "$env"; echo "already seeded"; exit 0; }
adminpw=$(openssl rand -hex 12); botpw=$(openssl rand -hex 12); hook=$(openssl rand -hex 24)
ensure_user() { # jmeno heslo [--admin]; po prerusenem seedu jen nastavi nove heslo
  fj admin user create ${3:-} --username "$1" --password "$2" --email "$1@factory.test" --must-change-password=false >/dev/null 2>&1 \
    || fj admin user change-password --username "$1" --password "$2" --must-change-password=false >/dev/null
}
ensure_user factory-admin "$adminpw" --admin
ensure_user factory-bot "$botpw"
sfx=$(openssl rand -hex 3)
tok=$(fj admin user generate-access-token --username factory-bot --token-name "factory-$sfx" --scopes write:repository,write:issue,read:user --raw)
atok=$(fj admin user generate-access-token --username factory-admin --token-name "admin-$sfx" --scopes all --raw)
A="Authorization: token $atok"; J="Content-Type: application/json"
curl -fsS -H "$A" -H "$J" $U/user/repos -d '{"name":"fixture","private":true,"default_branch":"main"}' >/dev/null
curl -fsS -X PUT -H "$A" -H "$J" $U/repos/factory-admin/fixture/collaborators/factory-bot -d '{"permission":"write"}' >/dev/null
curl -fsS -H "$A" -H "$J" $U/repos/factory-admin/fixture/labels -d '{"name":"factory","color":"#00aabb"}' >/dev/null
gw=$(docker network inspect factory-core -f '{{(index .IPAM.Config 0).Gateway}}')
curl -fsS -H "$A" -H "$J" $U/repos/factory-admin/fixture/hooks -d "{\"type\":\"forgejo\",\"active\":true,\"events\":[\"issues\",\"issue_comment\",\"pull_request_comment\"],\"config\":{\"url\":\"http://$gw:9000/webhook\",\"content_type\":\"json\",\"secret\":\"$hook\"}}" >/dev/null
t=$(mktemp -d); cp -r fixture/. "$t"; git -C "$t" init -q -b main
git -C "$t" add . ; git -C "$t" -c user.name=factory-admin -c user.email=admin@factory.test commit -qm "Initial fixture"
git -C "$t" -c http.extraheader="Authorization: Basic $(printf 'factory-admin:%s' "$atok" | base64 -w0)" push -q http://${FACTORY_BIND:-127.0.0.1}:3000/factory-admin/fixture.git main
rm -rf "$t"
umask 077
cat > "$env" <<EOF
FORGEJO_URL=http://${FACTORY_BIND:-127.0.0.1}:3000
FORGEJO_BOT_TOKEN=$tok
FORGEJO_ADMIN_TOKEN=$atok
FORGEJO_ADMIN_PASSWORD=$adminpw
WEBHOOK_SECRET=$hook
WEBHOOK_BIND=$gw
YFACTORY_PASSWORD=$(openssl rand -hex 16)
EOF
echo seeded
