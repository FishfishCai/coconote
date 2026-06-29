#!/usr/bin/env bash
# Unified local test runner for coconote. Runs every check in one shot and
# prints a single PASS/FAIL summary at the end, so one failing stage never
# hides the others.
#
# Stages, in order:
#   1. npm run check      (tsc type check)
#   2. npm run boundaries (depcruise: client import-tier rules)
#   3. npm run lint       (biome)
#   4. npm run build      (client bundle)
#   5. cargo test         (Rust server, server-rs/Cargo.toml)
#   6. npm run test:unit  (vitest client unit tests; skipped if the script
#      is not defined yet)
#   6. feature tests   (.claude/feature/tests/test_*.cjs) - LOCAL ONLY. They
#      spawn the release server, so `make release` runs first. The whole
#      .claude/feature/ tree is gitignored, so on a clean checkout / CI it
#      is absent and this stage is skipped.
#
# Run-all, not fail-fast: every stage runs even after a failure, but the
# script exits non-zero if ANY stage (or any feature test) failed. Mirror
# the same stages in CI via .github/workflows/ci.yml, minus the gitignored
# feature tests.
#
# Robust to the caller's directory: it cd's to the repo root first. Uses
# `set -u` only (no -e / no pipefail) on purpose, so a failing stage is
# recorded and the run continues instead of aborting.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NPM="${NPM:-npm}"
CARGO="${CARGO:-cargo}"

# Names of stages that failed, and the running ordered log of every stage's
# outcome (PASS / FAIL / SKIP) for the final summary.
FAILED=()
declare -a SUMMARY=()

banner() { printf "\n\033[1m========== %s ==========\033[0m\n" "$*"; }

# record <stage-name> <PASS|FAIL|SKIP> [note]
record() {
  local name="$1" status="$2" note="${3:-}"
  if [[ -n "$note" ]]; then
    SUMMARY+=("$status  $name ($note)")
  else
    SUMMARY+=("$status  $name")
  fi
  [[ "$status" == "FAIL" ]] && FAILED+=("$name")
  return 0
}

# stage <stage-name> <command...> : run a command, banner it, record outcome.
stage() {
  local name="$1"; shift
  banner "$name"
  printf "\033[2m\$ %s\033[0m\n" "$*"
  if "$@"; then
    record "$name" PASS
  else
    record "$name" FAIL "exit $?"
  fi
}

# Is an npm script defined in package.json? (avoids `npm run` exiting
# nonzero on a missing script, which would muddy the SKIP case).
npm_script_exists() {
  node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)" 2>/dev/null
}

# 1-3: client type check, import-tier boundaries, lint, bundle.
stage "check (tsc)"   "$NPM" run check
stage "boundaries (depcruise)" "$NPM" run boundaries
stage "lint (biome)"  "$NPM" run lint
stage "build (client bundle)" "$NPM" run build

# 4: Rust server tests.
stage "cargo test (server-rs)" "$CARGO" test --manifest-path server-rs/Cargo.toml

# 5: client unit tests (vitest). Skip cleanly until the script is added.
if npm_script_exists test:unit; then
  stage "test:unit (vitest)" "$NPM" run test:unit
else
  banner "test:unit (vitest)"
  echo "test:unit: skipped (no \"test:unit\" script in package.json yet)"
  record "test:unit (vitest)" SKIP "no script yet"
fi

# 6: feature tests - local-only, gitignored. Skip entirely when the tree is
# absent (clean checkout / CI). When present, build the release server once
# (the tests spawn it), then run each test_*.cjs and tally pass/fail.
FEATURE_DIR=".claude/feature"
FEATURE_TESTS="$FEATURE_DIR/tests"
if [[ ! -d "$FEATURE_DIR" ]]; then
  banner "feature tests"
  echo "feature tests: skipped (no .claude/feature)"
  record "feature tests" SKIP "no .claude/feature"
elif [[ ! -d "$FEATURE_TESTS" ]]; then
  banner "feature tests"
  echo "feature tests: skipped (no $FEATURE_TESTS)"
  record "feature tests" SKIP "no tests dir"
else
  # Glob the test files first so an empty dir is a clean skip, not a run of
  # the release build for nothing.
  shopt -s nullglob
  feature_files=("$FEATURE_TESTS"/test_*.cjs)
  shopt -u nullglob

  if [[ ${#feature_files[@]} -eq 0 ]]; then
    banner "feature tests"
    echo "feature tests: skipped (no test_*.cjs in $FEATURE_TESTS)"
    record "feature tests" SKIP "no test_*.cjs"
  else
    # The .cjs tests spawn server-rs/target/release/coconote, so build it
    # first. If the release build fails, the tests cannot run - record the
    # build failure and skip them rather than spawning a missing binary.
    stage "make release (for feature tests)" make release
    if [[ " ${FAILED[*]} " == *" make release (for feature tests) "* ]]; then
      banner "feature tests"
      echo "feature tests: skipped (make release failed)"
      record "feature tests" SKIP "release build failed"
    else
      banner "feature tests (${#feature_files[@]} file(s))"
      feat_pass=0
      feat_fail=0
      for f in "${feature_files[@]}"; do
        printf "\n\033[2m--- node %s ---\033[0m\n" "$f"
        if node "$f"; then
          feat_pass=$((feat_pass + 1))
        else
          feat_fail=$((feat_fail + 1))
          FAILED+=("feature: $(basename "$f")")
        fi
      done
      if [[ $feat_fail -eq 0 ]]; then
        record "feature tests" PASS "$feat_pass passed"
      else
        # The per-file failures are already in FAILED; this row is the rollup.
        SUMMARY+=("FAIL  feature tests ($feat_pass passed, $feat_fail failed)")
      fi
    fi
  fi
fi

# Final summary.
banner "SUMMARY"
for line in "${SUMMARY[@]}"; do
  printf "  %s\n" "$line"
done

if [[ ${#FAILED[@]} -eq 0 ]]; then
  printf "\n\033[1;32mALL STAGES PASSED\033[0m\n"
  exit 0
else
  printf "\n\033[1;31mFAILED (%d):\033[0m\n" "${#FAILED[@]}"
  for name in "${FAILED[@]}"; do
    printf "  - %s\n" "$name"
  done
  exit 1
fi
