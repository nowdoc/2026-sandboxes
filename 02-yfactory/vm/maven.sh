[ -n "${YF_PROXY_HOST:-}" ] && export MAVEN_ARGS="${MAVEN_ARGS:+$MAVEN_ARGS }--global-settings /etc/maven/settings-proxy.xml"
