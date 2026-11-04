FROM node:24.22.2-trixie-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null \
 && rm -rf /var/lib/apt/lists/*
COPY . /app
RUN ln -s /app/yf /usr/local/bin/yf
ENV NODE_ENV=production
USER 1000:1000
WORKDIR /app
CMD ["node", "main.ts"]
