#!/bin/sh
# Build the engine bridge for every supported computer into web/bridge/.
# Needs Go 1.22 or newer (https://go.dev/dl/). No other dependencies.
#
#   sh scripts/build_bridge.sh
set -eu
cd "$(dirname "$0")/.."
out="web/bridge"
mkdir -p "$out"
rm -f "$out"/mychessdb-bridge-* "$out/SHA256SUMS" "$out/version.json"

version=$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\(.*\)"$/\1/p' bridge/main.go | head -n 1)
for target in windows/amd64 windows/arm64 darwin/amd64 darwin/arm64 linux/amd64 linux/arm64; do
  os=${target%/*}
  arch=${target#*/}
  name="mychessdb-bridge-$os-$arch"
  [ "$os" = windows ] && name="$name.exe"
  echo "building $name"
  # -buildvcs=false: without it Go stamps the Git commit into the file, and
  # the same source would no longer give byte-identical files.
  (cd bridge && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -buildvcs=false -ldflags "-s -w -buildid=" -o "../$out/$name" .)
done

(cd "$out" && if command -v sha256sum >/dev/null 2>&1; then sha256sum mychessdb-bridge-*; else shasum -a 256 mychessdb-bridge-*; fi) > "$out/SHA256SUMS"
printf '{"version": "%s"}\n' "$version" > "$out/version.json"
echo "bridge $version built:"
cat "$out/SHA256SUMS"
