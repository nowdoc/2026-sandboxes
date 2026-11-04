FROM node:24.22.2-trixie-slim AS node
ARG OPENCODE_VERSION=1.19.5
RUN cd /tmp && npm pack -s opencode-linux-x64@${OPENCODE_VERSION} && tar -xzf opencode-linux-x64-*.tgz \
 && install -m 755 package/bin/opencode /usr/local/bin/opencode \
 && npm i -g -s typescript@7.0.2 pyright@1.1.414 && rm -rf /tmp/* /root/.npm

FROM debian:trixie-slim AS ide
ARG CODE_SERVER_VERSION=4.141.0
ADD --checksum=sha256:65bcd20b524d03eb1b5adb7f360244599ef0e5b74089a46a982d32c074b97a29 \
  https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz /tmp/cs.tgz
RUN mkdir /opt/code-server && tar -xzf /tmp/cs.tgz -C /opt/code-server --strip-components 1

FROM debian:trixie-slim
# safe.directory: setup and maintenance scripts run git as root in the agent's /workspace.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git curl ca-certificates ripgrep python3 >/dev/null \
 && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash -u 1000 agent && mkdir -p /workspace && chown agent /workspace \
 && git config --system --add safe.directory /workspace \
 && printf '[ -f ~/.yf-env ] && . ~/.yf-env\ncd /workspace 2>/dev/null\n' >> /home/agent/.bashrc
# JRE 25 only runs jdtls; java stays 21 for builds.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends php-cli php-xml php-mbstring php-curl php-zip php-sqlite3 unzip composer \
    openjdk-21-jdk-headless openjdk-25-jre-headless maven >/dev/null \
 && rm -rf /var/lib/apt/lists/* && update-alternatives --set java /usr/lib/jvm/java-21-openjdk-amd64/bin/java
COPY --from=node /usr/local/bin/ /usr/local/bin/
COPY --from=node /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=ide /opt/code-server/ /opt/code-server/
RUN ln -s /opt/code-server/bin/code-server /usr/local/bin/code-server && npm i -g -s intelephense@1.18.5 && rm -rf /root/.npm
# Maven ignores HTTP_PROXY. maven.sh points it to settings with the proxy host from the env.
COPY settings-proxy.xml /etc/maven/settings-proxy.xml
COPY maven.sh /etc/yfactory/env.d/maven.sh
# opencode's built-in jdtls launch passes JVM options after -jar and fails; the bundled launcher works.
ADD --checksum=sha256:b1f2abe0b3cccb462cf64fb4a5587c7d09df60cf8be7748b152cbd89d018bdc4 \
    https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz /tmp/jdtls.tar.gz
RUN mkdir /opt/jdtls && tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls && rm /tmp/jdtls.tar.gz && ln -s /opt/jdtls/bin/jdtls /usr/local/bin/jdtls
COPY --chown=agent java-opencode.json /home/agent/.config/opencode/opencode.json
# Not in /etc/opencode: opencode treats that directory as managed config that nothing can override.
COPY opencode.json /usr/local/share/yfactory/opencode.json
COPY --chmod=755 tsgo-lsp /usr/local/bin/tsgo-lsp
ENV OPENCODE_CONFIG=/usr/local/share/yfactory/opencode.json OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
    OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_EXPERIMENTAL_LSP_TOOL=1 PYTHONDONTWRITEBYTECODE=1
USER agent
WORKDIR /workspace
