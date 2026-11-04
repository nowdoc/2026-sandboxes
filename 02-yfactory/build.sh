#!/bin/sh
# Usage: build.sh [version]. Builds ynfra/yfactory:<service>-<version>.
# No version: the vN tag on HEAD, or the next vN, tagged on HEAD if the tree is clean. A vN must be the tag on HEAD,
# any other name (e.g. dev) builds the tree as it is. The commit is in the label org.opencontainers.image.revision.
# The VM image is ynfra/yfactory:vm-vN, built from vm/ with its own counter; prints "<version> <vm version>".
set -eu
cd "$(dirname "$0")"
# Git runs as the owner of the repository, so a new tag is not owned by root; only docker needs sudo.
[ "$(id -u)" != 0 ] || { echo "run build.sh as yourself, not with sudo" >&2; exit 1; }
clean() { [ -z "$(git status --porcelain -- .)" ]; }
head_tag=$(git tag --points-at HEAD --list 'v*' | grep -E '^v[0-9]+$' | sort -V | tail -1 || true)
v=${1:-$head_tag}
if [ -z "$v" ]; then
  clean || { echo "uncommitted changes in yfactory/, commit them or pass a version such as dev" >&2; exit 1; }
  last=$(git tag --list 'v*' | grep -E '^v[0-9]+$' | sort -V | tail -1 || true)
  last=${last:-v0}; v=v$(( ${last#v} + 1 ))
  git tag "$v"
elif echo "$v" | grep -qE '^v[0-9]+$'; then
  [ "$v" = "$head_tag" ] || { echo "$v is not the tag on HEAD${head_tag:+ ($head_tag is)}" >&2; exit 1; }
  clean || { echo "uncommitted changes in yfactory/, $v would not match its tag" >&2; exit 1; }
fi
rev=$(git rev-parse --short HEAD)$(clean || echo -dirty)
b() { sudo -n docker build -q --label "org.opencontainers.image.version=$v" --label "org.opencontainers.image.revision=$rev" "$@" >/dev/null; }
# The VM image has its own version vm-vN (git tag), new only when vm/ changed since the last one, so most deploys reuse it.
vm_tag=$(git tag --list 'vm-v*' | sort -V | tail -1 || true)
if [ -z "$vm_tag" ] || ! git diff --quiet "$vm_tag" -- vm; then
  vm_tag=vm-v$(( ${vm_tag#vm-v} + 1 )); clean && git tag "$vm_tag"
  b -t "ynfra/yfactory:$vm_tag" vm
fi
for s in sandbox orchestrator; do b -t "ynfra/yfactory:$s-$v" "$s"; done
echo "$v ${vm_tag#vm-}"
