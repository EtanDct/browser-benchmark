#!/usr/bin/env bash
# Runs inside WSL, driven from Windows by scripts/wsl.ts (npm run wsl -- ...). Every step is idempotent.
#   system                     (root) base packages
#   node                       Node.js 22 into ~/.local/lib/nodejs, linked from ~/.local/bin
#   sync <src> <dest>          mirror the Windows working tree (file list on stdin, NUL-separated) into <dest>
#   deps <dest>                npm ci, only when package-lock.json changed since the last install
#   browser-deps <dest> <node> (root) system libraries and fonts of every browser, via Playwright
#   browsers <dest>            Chrome for Testing, Playwright's Firefox and WebKit, Camoufox, Lightpanda
#   run <dest> <npm args...>   npm run <args> in <dest>
set -euo pipefail

NODE_MAJOR=22
LIGHTPANDA_VERSION=0.4.1
NODE_DIR="$HOME/.local/lib/nodejs"
# Linux tools first: WSL appends the Windows PATH, whose npm would run the Windows Node.js.
export PATH="$NODE_DIR/bin:$HOME/.local/bin:$PATH"

require_linux_npm() {
  case "$(command -v npm || true)" in
    "" | /mnt/*) echo "Node.js is not installed in WSL: run npm run wsl -- setup first" >&2; exit 1 ;;
  esac
}

step=${1:?step}
shift

case "$step" in
  system)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # unzip: Puppeteer extracts Chrome for Testing with it, and its postinstall fails silently without it.
    apt-get install -y -qq curl ca-certificates xz-utils unzip rsync python3 > /dev/null
    ;;

  node)
    if command -v node > /dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]; then
      echo "Node.js $(node -v) already installed"
      exit 0
    fi
    base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    file=$(grep -o "node-v[0-9.]*-linux-x64.tar.xz" "$tmp/SHASUMS256.txt" | head -1)
    echo "Downloading $file"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet)
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR" "$HOME/.local/bin"
    tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
    # Also on PATH in a WSL login shell, where Ubuntu's ~/.profile adds ~/.local/bin.
    ln -sf "$NODE_DIR/bin/node" "$NODE_DIR/bin/npm" "$NODE_DIR/bin/npx" "$HOME/.local/bin/"
    echo "Node.js $(node -v) installed"
    ;;

  sync)
    src=${1:?src}
    dest=${2:?dest}
    mkdir -p "$dest"
    list=$(mktemp)
    tr '\0' '\n' > "$list"
    rsync -lt --files-from="$list" "$src/" "$dest/"
    # Files synced last time and gone from Windows since: delete them. Anything else in <dest>
    # (node_modules, results, dashboard, a WSL-only .env) is never touched.
    if [ -f "$dest/.wsl-sync" ]; then
      comm -23 <(sort "$dest/.wsl-sync") <(sort "$list") | while IFS= read -r f; do rm -f "$dest/$f"; done
    fi
    mv "$list" "$dest/.wsl-sync"
    echo "Synced $(wc -l < "$dest/.wsl-sync") files to $dest"
    ;;

  deps)
    dest=${1:?dest}
    require_linux_npm
    cd "$dest"
    lock=$(sha256sum package-lock.json | cut -c1-64)
    if [ "$(cat node_modules/.wsl-lock 2>/dev/null)" != "$lock" ]; then
      npm ci --no-audit --no-fund
      echo "$lock" > node_modules/.wsl-lock
    fi
    ;;

  browser-deps)
    dest=${1:?dest}
    node=${2:?node}
    "$node" "$dest/node_modules/playwright/cli.js" install-deps chromium firefox webkit
    ;;

  browsers)
    dest=${1:?dest}
    cd "$dest"
    # An interrupted Chrome download leaves an empty version folder, which Puppeteer then refuses to fill.
    find "$HOME/.cache/puppeteer" -mindepth 2 -maxdepth 2 -type d -empty -delete 2>/dev/null || true
    npm run install-browsers
    if [ -e "${CAMOUFOX_INSTALL_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/camoufox}/camoufox-bin" ]; then
      echo "Camoufox already installed"
    else
      npx camoufox-js fetch
    fi
    if [ -x "$HOME/.local/bin/lightpanda" ]; then
      echo "Lightpanda $("$HOME/.local/bin/lightpanda" version) already installed"
    else
      mkdir -p "$HOME/.local/bin"
      curl -fsSL -o "$HOME/.local/bin/lightpanda" "https://github.com/lightpanda-io/browser/releases/download/$LIGHTPANDA_VERSION/lightpanda-x86_64-linux"
      chmod a+x "$HOME/.local/bin/lightpanda"
      echo "Lightpanda $("$HOME/.local/bin/lightpanda" version) installed"
    fi
    ;;

  run)
    dest=${1:?dest}
    shift
    require_linux_npm
    cd "$dest"
    exec npm run "$@"
    ;;

  *)
    echo "unknown step: $step" >&2
    exit 2
    ;;
esac
