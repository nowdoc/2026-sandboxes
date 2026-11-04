#!/bin/sh
# Bezi v sandboxu s dockerd. Spusti fixture a pocka na healthchecky.
s=$(date +%s)
[ -d /usr/local/sbin/.iptables-legacy ] && export PATH=/usr/local/sbin/.iptables-legacy:$PATH
dockerd >/tmp/dockerd.log 2>&1 &
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { echo DOCKERD_FAIL; tail -8 /tmp/dockerd.log; exit 2; }
echo "dockerd up in $(( $(date +%s)-s ))s"
cd /fixture && docker compose up -d --wait --wait-timeout 240 2>&1 | tail -3
rc=$?
echo "healthy: $(docker compose ps --format '{{.Health}}' | grep -c healthy)/15, total $(( $(date +%s)-s ))s"
docker compose exec -T web nslookup web.cz.test 172.30.0.2 2>&1 | tail -2
exit $rc
