# Rust backend + TypeScript client + Electron shell.
#   make build           -> debug server at server-rs/target/debug/coconote
#                          (symlinked to ./coconote)
#   make release         -> optimized server at server-rs/target/release/coconote
#   make release-cross   -> linux + macOS + windows release server binaries via
#                          `cargo zigbuild` (zig must be installed)
#   make app             -> desktop app via Electron + electron-builder (host OS)
#   make package         -> scripts/package.sh: dist/server/*.zip for 6 targets
#                          + dist/app/*.{dmg,deb,AppImage,exe} for the host
#   make package-server  -> just the server zips
#   make package-app     -> just the host app installers
#   make clean           -> cargo clean + remove client / electron build outputs
#   make test            -> cargo test + npm run check
#   make test-all        -> scripts/test_all.sh: full local suite (tsc, biome,
#                          client bundle, cargo test, vitest, + feature tests
#                          when .claude/feature/ exists)

CARGO ?= cargo
NPM ?= npm
# Compile-time injected so /.health reports the real build moment, via
# option_env!("COCONOTE_BUILD_TIME") in server-rs/src/bin/coconote.rs.
# Override: `make build COCONOTE_BUILD_TIME=...`.
COCONOTE_BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
export COCONOTE_BUILD_TIME

# electron-builder arch flag for the HOST. stage_sidecar.sh stages the
# host-arch sidecar, so the installer arch must follow the host: a
# hardcoded pin would package the other arch with no server.
EB_ARCH := $(if $(filter arm64 aarch64,$(shell uname -m)),--arm64,--x64)

.PHONY: build release release-cross clean test test-all check fmt setup app \
        package package-server package-app

setup:
	$(NPM) install
	test -d server-rs/target || $(CARGO) fetch --manifest-path server-rs/Cargo.toml

build:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	$(CARGO) build --manifest-path server-rs/Cargo.toml
	@[ "$$(readlink coconote)" = server-rs/target/debug/coconote ] || ln -sf server-rs/target/debug/coconote coconote

release:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	$(CARGO) build --manifest-path server-rs/Cargo.toml --release
	@[ "$$(readlink coconote)" = server-rs/target/release/coconote ] || ln -sf server-rs/target/release/coconote coconote

# Stage the sidecar where electron-builder's `extraResources` expects it
# (binaries/<platform>-<arch>/coconote), then build for the host OS *and
# host arch* ($(EB_ARCH), matching what stage_sidecar.sh staged). Only the
# current platform's installer (DMG, AppImage/DEB, or NSIS .exe) is
# produced: native packagers can't cross-bundle. --config is explicit
# because electron-builder does not auto-detect builder.config.json.
app:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	$(CARGO) build --manifest-path server-rs/Cargo.toml --release
	@bash scripts/stage_sidecar.sh
	cd electron && test -d node_modules || $(NPM) install
	cd electron && $(NPM) run build -- --config builder.config.json $(EB_ARCH)
	@echo "Installers under electron/dist/"

# Triple list comes from scripts/targets.sh (the canonical source shared with
# scripts/package.sh and .github/workflows/release.yml) - edit targets there,
# not here. Locally every triple is built with `cargo zigbuild` (zig must be
# installed); the runner/use_zigbuild columns in that file are CI-only.
# windows-gnu (not msvc): zigbuild cross-compiles gnu from non-Windows hosts
# for the standalone server zip; the desktop sidecar uses msvc natively on the
# Windows runner (release.yml app job).
release-cross:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	@for triple in $$(bash scripts/targets.sh triples); do \
	  echo "==> zigbuild $$triple"; \
	  $(CARGO) zigbuild --manifest-path server-rs/Cargo.toml --release --target $$triple || exit 1; \
	done

test:
	$(NPM) run check
	$(CARGO) test --manifest-path server-rs/Cargo.toml

# Full local suite: tsc + biome + client bundle + cargo test + vitest, plus
# the gitignored feature tests when .claude/feature/ is present. Run-all,
# exits non-zero if any stage fails. See scripts/test_all.sh.
test-all:
	bash scripts/test_all.sh

check: test

fmt:
	npx biome format --write .
	$(CARGO) fmt --manifest-path server-rs/Cargo.toml

package:
	bash scripts/package.sh

package-server:
	bash scripts/package.sh --server-only

package-app:
	bash scripts/package.sh --app-only

clean:
	$(CARGO) clean --manifest-path server-rs/Cargo.toml
	rm -rf embed/client server-rs/embed/client dist
	rm -rf electron/dist electron/binaries electron/node_modules
	rm -f coconote
