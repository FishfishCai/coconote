#!/usr/bin/env bash
# Canonical cross-compile target list - THE single source of truth for the 6
# standalone-server build targets. Edit the targets HERE and nowhere else.
#
# Consumed by:
#   - Makefile (release-cross): `bash scripts/targets.sh triples`, zigbuild each
#   - scripts/package.sh (build_server): sources this file, loops the array
#   - .github/workflows/release.yml (prep job): `bash scripts/targets.sh json`
#     emits the server-job matrix, consumed via fromJSON (no copy-paste drift)
#
# Row columns (whitespace separated):
#   triple  os_label  arch_label  bin  runner  use_zigbuild
# os_label/arch_label name the artifact: coconote-server-<os>-<arch>.zip.
# runner + use_zigbuild are CI-only (the release.yml matrix). Locally
# (Makefile + package.sh) every triple is built with `cargo zigbuild`.
# windows-gnu (not msvc) on purpose: zigbuild can cross-compile gnu from
# non-Windows hosts for the standalone server zip; the desktop sidecar is
# built with msvc natively on the Windows runner (release.yml app job).

COCONOTE_TARGETS=(
  "aarch64-apple-darwin       darwin      aarch64  coconote      macos-latest   false"
  "x86_64-apple-darwin        darwin      x86_64   coconote      macos-latest   true"
  "aarch64-unknown-linux-gnu  linux       aarch64  coconote      ubuntu-latest  true"
  "x86_64-unknown-linux-gnu   linux       x86_64   coconote      ubuntu-latest  true"
  "x86_64-unknown-linux-musl  linux-musl  x86_64   coconote      ubuntu-latest  true"
  "x86_64-pc-windows-gnu      windows     x86_64   coconote.exe  ubuntu-latest  true"
)

# When executed directly (not sourced), print the list in the requested form.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-rows}" in
    triples)
      for _row in "${COCONOTE_TARGETS[@]}"; do
        read -r _triple _ <<<"$_row"
        printf '%s\n' "$_triple"
      done
      ;;
    rows)
      printf '%s\n' "${COCONOTE_TARGETS[@]}"
      ;;
    json)
      _out='{"include":['
      _first=1
      for _row in "${COCONOTE_TARGETS[@]}"; do
        read -r _triple _os _arch _bin _runner _zb <<<"$_row"
        if [[ $_first -eq 1 ]]; then _first=0; else _out+=','; fi
        _out+=$(printf '{"triple":"%s","runner":"%s","os_label":"%s","arch_label":"%s","bin":"%s","use_zigbuild":%s}' \
          "$_triple" "$_runner" "$_os" "$_arch" "$_bin" "$_zb")
      done
      _out+=']}'
      printf '%s\n' "$_out"
      ;;
    *)
      echo "usage: targets.sh [triples|rows|json]" >&2
      exit 2
      ;;
  esac
fi
