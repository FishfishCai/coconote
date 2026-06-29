#!/usr/bin/env bash
# Stage the just-built coconote server at electron/binaries/<platform-arch>/
# for electron-builder's `extraResources`. Assumes the host release binary
# exists (Makefile `app` runs `cargo build --release` first).
#
# builder.config.json pins no arch on purpose (its schema allows no comment
# saying so): Makefile / package.sh / CI pass --arm64/--x64 for the HOST, so
# the packaged arch always matches what is staged here. A hardcoded pin
# would ship an installer without a server.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Platform/arch must match electron-builder's ${platform}-${arch} macro
# (builder.config.json extraResources): process.platform (darwin/linux/win32)
# and process.arch (arm64/x64), NOT mac/win.
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux)  PLATFORM=linux ;;
  CYGWIN*|MINGW*|MSYS*) PLATFORM=win32 ;;
  *) echo "stage_sidecar: unknown OS $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "stage_sidecar: unknown arch $(uname -m)" >&2; exit 1 ;;
esac

DST_DIR="electron/binaries/${PLATFORM}-${ARCH}"
mkdir -p "$DST_DIR"

if [[ "$PLATFORM" == "win32" ]]; then
  cp server-rs/target/release/coconote.exe "$DST_DIR/coconote.exe"
  chmod +x "$DST_DIR/coconote.exe"
else
  cp server-rs/target/release/coconote "$DST_DIR/coconote"
  chmod +x "$DST_DIR/coconote"
fi

echo "Staged sidecar at $DST_DIR/"
