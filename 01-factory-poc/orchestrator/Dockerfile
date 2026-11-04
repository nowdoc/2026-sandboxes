FROM node:24.22.2-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli git iproute2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
