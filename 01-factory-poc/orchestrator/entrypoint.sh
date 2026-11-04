#!/bin/sh
# Alias gateway po rebootu chybi a jeji kontejnery bez nej nenastartuji, proto je pusti az tady.
set -eu
ip addr replace 198.18.0.10/32 dev lo
docker start factory-llm-gw factory-pkg-gw >/dev/null || echo "gateway se nespustila" >&2
exec node factory.ts
