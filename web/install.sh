#!/bin/sh
# My Chess DB engine bridge installer for macOS and Linux.
#
# Run the command shown on the site, which looks like:
#   curl -fsSL https://SITE/install.sh | MYCHESSDB_SITE=https://SITE sh
#
# It downloads the bridge for this computer into your home folder, checks the
# file against the site's checksum list, adds a launcher, and starts it. The
# bridge then downloads the official Stockfish 19 by itself. Nothing is
# installed system-wide and no administrator rights are needed.
set -eu

site="${MYCHESSDB_SITE:-}"
if [ -z "$site" ]; then
  echo "MYCHESSDB_SITE is not set. Copy the whole install command from the site." >&2
  exit 1
fi
site="${site%/}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "This installer supports macOS and Linux. On Windows use the PowerShell command from the site." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "Unsupported processor type: $(uname -m)" >&2; exit 1 ;;
esac
name="mychessdb-bridge-$os-$arch"

if [ "$os" = darwin ]; then
  dir="$HOME/Library/Application Support/MyChessDB"
else
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/mychessdb"
fi
mkdir -p "$dir"
target="$dir/mychessdb-bridge"
download="$target.download"

fetch() { # fetch URL FILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    echo "Neither curl nor wget is available." >&2
    exit 1
  fi
}

echo "Downloading $name ..."
fetch "$site/bridge/$name" "$download"
fetch "$site/bridge/SHA256SUMS" "$dir/SHA256SUMS"
# (tolerates Windows line endings in the list)
expected=$(awk -v file="$name" '{ sub(/\r$/, "") } $2 == file { print $1 }' "$dir/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$download" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$download" | awk '{ print $1 }')
fi
rm -f "$dir/SHA256SUMS"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  rm -f "$download"
  echo "The download does not match the site's checksum. Nothing was installed." >&2
  exit 1
fi
chmod +x "$download"
mv -f "$download" "$target"

# A launcher for next time.
if [ "$os" = darwin ]; then
  mkdir -p "$HOME/Applications"
  launcher="$HOME/Applications/My Chess DB Bridge.command"
  printf '#!/bin/sh\nexec "%s" -site "%s"\n' "$target" "$site" > "$launcher"
  chmod +x "$launcher"
  echo "Next time, open \"My Chess DB Bridge\" in the Applications folder inside your home folder."
else
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
  ln -sf "$target" "$HOME/.local/bin/mychessdb-bridge"
  cat > "$HOME/.local/share/applications/mychessdb-bridge.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=My Chess DB Bridge
Comment=Runs Stockfish on this computer for the My Chess DB site
Exec="$target" -site "$site"
Terminal=true
Categories=Game;
DESKTOP
  echo "Next time, start \"My Chess DB Bridge\" from your applications menu, or run: mychessdb-bridge"
fi

echo "Starting the bridge. Keep this window open while you analyse."
exec "$target" -site "$site"
