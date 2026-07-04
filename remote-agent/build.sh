#!/usr/bin/env bash
# build.sh — cross-compile the remote-agent daemon to static, dependency-free
# binaries you can scp to any Linux box (no Go/toolchain needed on the target).
#
#   bash build.sh              # build linux/amd64 + linux/arm64 into dist/
#   GOOS=linux GOARCH=arm64 go build .   # or roll your own
#
# CGO is disabled: creack/pty is pure Go on Linux, so the result is a single
# statically-linked file — the whole reason the daemon was ported from Node
# (docs/custom-vm-providers.md §3.4).
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p dist
export CGO_ENABLED=0

for pair in linux/amd64 linux/arm64; do
  goos="${pair%/*}"
  goarch="${pair#*/}"
  out="dist/remote-agent-${goos}-${goarch}"
  echo "==> building ${out}"
  GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="-s -w" -o "$out" .
done

echo ""
echo "Done. Binaries:"
ls -lh dist/
