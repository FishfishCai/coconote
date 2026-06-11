#!/usr/bin/env bash
# Build artifacts for distribution.
#
# Produces:
#   dist/server/coconote-server-<version>-<os>-<arch>.zip
#       Cross-built standalone HTTP server binaries (6 targets).
#
#   dist/app/coconote-<version>-<os>-<arch>.<ext>
#       Electron desktop installers for whichever host this runs on:
#         macOS   → .dmg
#         Linux   → .deb / .AppImage
#         Windows → .exe (NSIS).
#
# The "server" half cross-compiles via `cargo zigbuild` from any host.
# The "app" half only produces installers for the current OS because
# electron-builder's native packagers (dpkg, dmg, NSIS) don't
# cross-bundle. Run this script on each platform to fill the matrix.
#
# Flags:
#   --server-only   skip the Electron app bundle (CI fan-out)
#   --app-only      skip the cross-platform server zips
#   --skip-targets  comma-separated server targets to skip
#
# Outputs live under dist/ at the repo root and are gitignored.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
DIST_SERVER="dist/server"
DIST_APP="dist/app"
mkdir -p "$DIST_SERVER" "$DIST_APP"

WANT_SERVER=1
WANT_APP=1
SKIP_TARGETS=""
for arg in "$@"; do
  case "$arg" in
    --server-only) WANT_APP=0 ;;
    --app-only)    WANT_SERVER=0 ;;
    --skip-targets=*) SKIP_TARGETS="${arg#*=}" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf "\n\033[1m▸ %s\033[0m\n" "$*"; }

ensure_client_bundle() {
  if [[ ! -d embed/client/.client ]]; then
    say "Building client bundle"
    npm install --silent
    npm run build
  fi
}

build_server() {
  ensure_client_bundle
  # Mirror the 6 server targets built in CI (.github/workflows/release.yml).
  local targets=(
    "aarch64-apple-darwin        darwin     aarch64 coconote"
    "x86_64-apple-darwin         darwin     x86_64  coconote"
    "aarch64-unknown-linux-gnu   linux      aarch64 coconote"
    "x86_64-unknown-linux-gnu    linux      x86_64  coconote"
    "x86_64-unknown-linux-musl   linux-musl x86_64  coconote"
    # windows-gnu (not msvc) on purpose: gnu is what zigbuild can cross-compile from non-Windows hosts for the server zip; the desktop sidecar uses msvc natively on the Windows CI runner.
    "x86_64-pc-windows-gnu       windows    x86_64  coconote.exe"
  )
  for row in "${targets[@]}"; do
    read -r triple os arch bin <<<"$row"
    if [[ ",$SKIP_TARGETS," == *,$triple,* ]]; then
      say "Skipping $triple (--skip-targets)"
      continue
    fi
    say "Building server for $triple"
    if ! cargo zigbuild --manifest-path server-rs/Cargo.toml --release --target "$triple"; then
      echo "WARN: $triple build failed — skipping." >&2
      continue
    fi
    local out="$DIST_SERVER/coconote-server-v${VERSION}-${os}-${arch}.zip"
    local stage; stage="$(mktemp -d)"
    cp "server-rs/target/$triple/release/$bin" "$stage/"
    # No per-user yaml shipped: the server auto-creates one at the
    # standard config dir on first launch (welcome.md §coconote.yaml).
    cp introduction/welcome.md "$stage/README.md"
    (cd "$stage" && zip -q "$ROOT/$out" "$bin" README.md)
    rm -rf "$stage"
    echo "→ $out"
  done
}

build_app() {
  ensure_client_bundle
  # Electron-builder bundles the server binary via the `extraResources`
  # mapping in electron/builder.config.json, which looks for it under
  # electron/binaries/<platform>-<arch>/. stage_sidecar.sh handles the
  # naming + chmod.
  say "Building server for host (Electron sidecar)"
  cargo build --manifest-path server-rs/Cargo.toml --release
  bash scripts/stage_sidecar.sh

  say "Installing electron deps"
  (cd electron && npm install --silent)

  say "Building Electron bundle"
  # Pass the HOST arch explicitly so electron-builder packages the same
  # arch stage_sidecar.sh just staged, and point it at builder.config.json
  # (not a filename electron-builder auto-detects).
  local eb_arch
  case "$(uname -m)" in
    arm64|aarch64) eb_arch=--arm64 ;;
    *)             eb_arch=--x64 ;;
  esac
  (cd electron && npm run build -- --config builder.config.json "$eb_arch")

  # electron-builder writes to electron/dist/.
  local bundle_root="electron/dist"
  local host_os host_arch
  case "$(uname -s)" in
    Darwin)  host_os=darwin ;;
    Linux)   host_os=linux ;;
    CYGWIN*|MINGW*|MSYS*) host_os=windows ;;
    *) host_os="unknown" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) host_arch=aarch64 ;;
    x86_64|amd64)  host_arch=x86_64 ;;
    *) host_arch="$(uname -m)" ;;
  esac

  if [[ -d "$bundle_root" ]]; then
    say "Collecting installers"
    find "$bundle_root" -maxdepth 2 -type f \( \
        -name "*.dmg" -o -name "*.deb" -o -name "*.AppImage" -o \
        -name "*.exe" -o -name "*.msi" \
      \) -print0 | while IFS= read -r -d '' f; do
        local base ext
        base="$(basename "$f")"
        ext="${base##*.}"
        local dst="$DIST_APP/coconote-v${VERSION}-${host_os}-${host_arch}.${ext}"
        cp "$f" "$dst"
        echo "→ $dst"
    done
  else
    echo "Electron bundle root missing — nothing copied to $DIST_APP" >&2
  fi
}

[[ "$WANT_SERVER" == 1 ]] && build_server
[[ "$WANT_APP"    == 1 ]] && build_app

say "Done. dist/ tree:"
find dist -type f -maxdepth 3 | sort
