#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./.env

usage() {
  cat <<EOF
Usage: yfactory.sh <command> [args]

  init                 create directories, secrets and the S3 bucket (idempotent)
  up                   init, load the sandbox image and start everything
  down                 stop everything
  restart [service]    recreate a service (default: yfactory), e.g. after editing config/ or secrets/; VMs survive
  deploy <version> [vm-version]  set YF_VERSION (and YF_VM_VERSION) in .env, run up, remove old ynfra/yfactory images and the build cache
  status               container status
  logs [service]       follow logs (default: yfactory)

  runs                 list runs
  new <repo> [prompt]  start a run, without a prompt only a sandbox
  shell <id>           bash in the run VM
  publish <id>         push the run branch to GitHub and open a PR
  rm <id>              export sessions to S3 and delete the VM
EOF
}

rand() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

# Created by root through sudo, but the user who ran sudo should be able to read and edit them.
own_secrets() {
  if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then chown "$SUDO_USER:$(id -gn "$SUDO_USER")" secrets secrets/*; fi
}

init() {
  umask 077
  mkdir -p secrets data/litellm-db data/garage
  (umask 022; mkdir -p data/yfactory data/sandbox data/images)
  # msb refuses an MSB_HOME below a group-writable directory
  chmod 755 data data/yfactory data/sandbox
  [ "$(id -u)" != 0 ] || chown 1000:1000 data/yfactory data/sandbox
  mkdir -p data/victorialogs data/victoriametrics data/grafana
  [ "$(id -u)" != 0 ] || { chown 1000:1000 data/victorialogs data/victoriametrics; chown 472:0 data/grafana; }

  [ -f secrets/garage.env ] || printf 'GARAGE_RPC_SECRET=%s\nGARAGE_ADMIN_TOKEN=%s\n' "$(rand 32)" "$(rand 32)" > secrets/garage.env
  [ -f secrets/sandbox.env ] || echo "SANDBOX_TOKEN=$(rand 32)" > secrets/sandbox.env
  [ -f secrets/litellm.env ] || printf 'LITELLM_MASTER_KEY=sk-%s\nOPENAI_API_URL=\nOPENAI_API_KEY=\n' "$(rand 24)" > secrets/litellm.env
  # The master key is the one value kept in two files: yfactory needs it, litellm.env also holds the upstream key.
  [ -f secrets/yfactory.env ] || printf '%s\nGITHUB_TOKEN_EXAMPLE=\n' "$(grep '^LITELLM_MASTER_KEY=' secrets/litellm.env)" > secrets/yfactory.env
  if [ ! -f secrets/db.env ]; then
    pw=$(rand 16)
    printf 'POSTGRES_USER=litellm\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=litellm\nDATABASE_URL=postgresql://litellm:%s@db:5432/litellm\n' "$pw" "$pw" > secrets/db.env
  fi
  [ -f secrets/grafana.env ] || echo "GF_SECURITY_ADMIN_PASSWORD=$(rand 16)" > secrets/grafana.env

  docker compose up -d --quiet-pull --remove-orphans garage
  [ -f secrets/s3.env ] && return
  g() { docker compose exec -T garage /garage "$@"; }
  until g status >/dev/null 2>&1; do sleep 1; done
  g layout assign -z dc1 -c 20G "$(g node id -q | cut -d@ -f1)" >/dev/null
  g layout apply --version 1 >/dev/null
  g bucket create yfactory >/dev/null
  out=$(g key create yfactory)
  g bucket allow --read --write yfactory --key yfactory >/dev/null
  printf 'S3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\n' \
    "$(echo "$out" | awk '/Key ID/ {print $NF}')" "$(echo "$out" | awk '/Secret key/ {print $NF}')" > secrets/s3.env
}

# The sandbox service has no Docker, msb loads the VM image from a tar.
save_images() {
  tar=data/images/vm-$YF_VM_VERSION.tar
  if [ ! -f "$tar" ]; then
    docker save "ynfra/yfactory:vm-$YF_VM_VERSION" -o "$tar.tmp"
    chmod 644 "$tar.tmp" && mv "$tar.tmp" "$tar"
  fi
  find data/images -name '*.tar' ! -name "vm-$YF_VM_VERSION.tar" -delete
}

yf() { if [ -t 0 ]; then docker exec -it yfactory yf "$@"; else docker exec -i yfactory yf "$@"; fi; }

cmd=${1:-help}
[ $# -gt 0 ] && shift
case "$cmd" in
  init) init; own_secrets ;;
  up) init; save_images; docker compose up -d --quiet-pull --remove-orphans; own_secrets ;;
  down) docker compose down ;;
  # Recreate, not restart: docker compose restart keeps the old env_file values.
  restart) docker compose up -d --no-deps --force-recreate "${1:-yfactory}" ;;
  deploy)
    [ -n "${1:-}" ] || { usage; exit 1; }
    prev=$YF_VERSION prev_vm=$YF_VM_VERSION
    sed -i "s/^YF_VERSION=.*/YF_VERSION=$1/" .env
    [ -z "${2:-}" ] || sed -i "s/^YF_VM_VERSION=.*/YF_VM_VERSION=$2/" .env
    "$0" up
    . ./.env
    # The previous version stays for a rollback (set it back in .env and run up); older ones and the build cache go.
    docker images --format '{{.Repository}}:{{.Tag}}' | grep '^ynfra/yfactory:' \
      | grep -Ev -- "^ynfra/yfactory:(vm-($YF_VM_VERSION|$prev_vm)|[a-z]+-($YF_VERSION|$prev))\$" | xargs -r docker rmi -f >/dev/null
    docker builder prune -f >/dev/null ;;
  status) docker compose ps ;;
  logs) docker compose logs -f --tail 100 "${1:-yfactory}" ;;
  runs) yf ls ;;
  shell)
    echo "${1:-}" | grep -qE '^[0-9a-f]+$' || { usage; exit 1; }
    docker exec -it sandbox msb exec -t -u agent "yf-$1" -- bash -l ;;
  new|publish|rm) yf "$cmd" "$@" ;;
  *) usage ;;
esac
