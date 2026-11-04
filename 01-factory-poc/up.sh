#!/bin/sh
# Spusti zakladni sluzby. Klice generuje jen pri prvnim startu.
set -eu
cd "$(dirname "$0")"
export FACTORY_ROOT="$(pwd)"
export FACTORY_HOME="${FACTORY_HOME:-${HOME:-/home/sandbox}}"
export FACTORY_BIND="${FACTORY_BIND:-127.0.0.1}"
docker network inspect factory-core >/dev/null 2>&1 || docker network create factory-core >/dev/null
if [ ! -f litellm/.env ]; then
  pw=$(openssl rand -hex 16)
  umask 077
  cat > litellm/.env <<EOF
LITELLM_MASTER_KEY=sk-$(openssl rand -hex 24)
DATABASE_URL=postgresql://litellm:$pw@db:5432/litellm
POSTGRES_USER=litellm
POSTGRES_PASSWORD=$pw
POSTGRES_DB=litellm
# ANTHROPIC_API_KEY=
EOF
fi
# Adresa pro publikovane porty gateway (sbx, e2b); po rebootu zmizi, proto je tady.
ip -4 addr show dev lo | grep -q 198.18.0.10 || ip addr add 198.18.0.10/32 dev lo
for s in forgejo litellm gateway orchestrator; do docker compose -f $s/compose.yml up -d --quiet-pull; done
