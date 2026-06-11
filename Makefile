# Rust backend + TypeScript client + Electron shell.
#   make build           → debug server at server-rs/target/debug/coconote
#                          (also symlinked to ./coconote for convenience)
#   make release         → optimized server at server-rs/target/release/coconote
#   make release-cross   → linux + macOS + windows release server binaries via
#                          `cargo zigbuild` (zig must be installed)
#   make app             → desktop app via Electron + electron-builder (host OS)
#   make package         → run scripts/package.sh — produces dist/server/*.zip
#                          for 6 targets + dist/app/*.{dmg,deb,AppImage,exe}
#                          for the host.
#   make package-server  → just the server zips.
#   make package-app     → just the host app installers.
#   make clean           → cargo clean + remove client / electron build outputs
#   make test            → cargo test + npm run check

CARGO ?= cargo
NPM ?= npm
# Injected into the coconote binary at compile time so /.health reports
# the actual build moment. Consumed by `option_env!("COCONOTE_BUILD_TIME")`
# in server-rs/src/bin/coconote.rs. Override with
# `make build COCONOTE_BUILD_TIME=...`.
COCONOTE_BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
export COCONOTE_BUILD_TIME

# electron-builder arch flag for the HOST. stage_sidecar.sh stages the
# sidecar for the host arch, so the installer arch must follow the host
# too — a hardcoded pin would package the other arch with no server.
EB_ARCH := $(if $(filter arm64 aarch64,$(shell uname -m)),--arm64,--x64)

.PHONY: build release release-cross clean test check fmt setup app \
        package package-server package-app

setup:
	$(NPM) install
	test -d server-rs/target || $(CARGO) fetch --manifest-path server-rs/Cargo.toml

build:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	$(CARGO) build --manifest-path server-rs/Cargo.toml
	@ln -sf server-rs/target/debug/coconote coconote

release:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	$(CARGO) build --manifest-path server-rs/Cargo.toml --release
	@ln -sf server-rs/target/release/coconote coconote

# Stage the sidecar where electron-builder's `extraResources` expects it
# (binaries/<platform>-<arch>/coconote), then run electron-builder for
# the host OS *and host arch* ($(EB_ARCH), matching what stage_sidecar.sh
# staged). Only the current platform's installer is produced — DMG,
# AppImage/DEB, or NSIS .exe — because native packagers can't
# cross-bundle. --config is passed explicitly: builder.config.json is
# not a filename electron-builder auto-detects.
app:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	$(CARGO) build --manifest-path server-rs/Cargo.toml --release
	@bash scripts/stage_sidecar.sh
	cd electron && test -d node_modules || $(NPM) install
	cd electron && $(NPM) run build -- --config builder.config.json $(EB_ARCH)
	@echo "Installers under electron/dist/"

release-cross:
	@test -d node_modules || $(NPM) install
	$(NPM) run build
	$(CARGO) zigbuild --manifest-path server-rs/Cargo.toml --release --target aarch64-apple-darwin
	$(CARGO) zigbuild --manifest-path server-rs/Cargo.toml --release --target x86_64-apple-darwin
	$(CARGO) zigbuild --manifest-path server-rs/Cargo.toml --release --target aarch64-unknown-linux-gnu
	$(CARGO) zigbuild --manifest-path server-rs/Cargo.toml --release --target x86_64-unknown-linux-gnu
	$(CARGO) zigbuild --manifest-path server-rs/Cargo.toml --release --target x86_64-unknown-linux-musl
# windows-gnu (not msvc) on purpose: gnu is the toolchain zigbuild can cross-compile from non-Windows hosts for the standalone server zip; the desktop sidecar is built with msvc natively on the Windows runner (release.yml app job).
	$(CARGO) zigbuild --manifest-path server-rs/Cargo.toml --release --target x86_64-pc-windows-gnu

test:
	$(NPM) run check
	$(CARGO) test --manifest-path server-rs/Cargo.toml

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
