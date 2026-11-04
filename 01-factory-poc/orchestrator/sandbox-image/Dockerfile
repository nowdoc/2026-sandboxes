FROM python:3.13-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git curl ca-certificates >/dev/null \
 && useradd -m agent && mkdir -p /workspace /task && chown agent /workspace /task
USER agent
WORKDIR /workspace
