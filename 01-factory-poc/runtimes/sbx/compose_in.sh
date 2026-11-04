s=$(date +%s)
cd /tmp/f/fixture && docker compose up -d --wait --wait-timeout 240 2>&1 | tail -4
echo "healthy: $(docker compose ps --format '{{.Health}}' | grep -c healthy)/15, total $(( $(date +%s)-s ))s"
docker compose exec -T web nslookup web.cz.test 172.30.0.2 2>&1 | tail -2
