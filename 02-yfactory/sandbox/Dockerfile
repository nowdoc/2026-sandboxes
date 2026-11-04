FROM node:24.22.2-trixie-slim
ADD --checksum=sha256:cf977489fa0e6c317af96ec720358baef564fa791362d8de41534a90fff53ad1 \
  https://github.com/superradcompany/microsandbox/releases/download/v0.7.12/microsandbox-linux-x86_64.tar.gz /tmp/msb.tgz
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates >/dev/null \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/msb/bin /opt/msb/lib && tar -xzf /tmp/msb.tgz -C /tmp && rm /tmp/msb.tgz \
 && install -m 755 /tmp/msb /opt/msb/bin/msb && install -m 644 /tmp/libkrunfw.so.5.6.1 /opt/msb/lib/ \
 && ln -s libkrunfw.so.5.6.1 /opt/msb/lib/libkrunfw.so.5 && ln -s libkrunfw.so.5 /opt/msb/lib/libkrunfw.so && rm /tmp/msb /tmp/libkrunfw.so.5.6.1
COPY server.ts proc.ts metrics.ts proxy.ts /app/
ENV PATH=/opt/msb/bin:$PATH NODE_ENV=production
USER 1000:1000
WORKDIR /app
CMD ["node", "server.ts"]
