// afterPack hook (macOS only). Runs after the app dir is assembled —
// including our injected sidecar under Resources/binaries — and before
// the dmg is built. Two jobs:
//
//   1. Trim the ~40 MB of unused Chromium locale packs. electron-builder's
//      `electronLanguages` option prunes Windows/Linux .pak files but
//      misses the macOS `Electron Framework.framework/.../<lang>.lproj`
//      packs; Chromium falls back to en and the UI is English-only.
//
//   2. Ad-hoc re-sign the whole bundle. Without an Apple Developer cert
//      electron-builder SKIPS macOS signing, leaving the stock Electron
//      binary's original signature — which no longer matches our modified
//      bundle (added sidecar, trimmed locales) → macOS reports the app as
//      "damaged". A clean ad-hoc signature whose identifier is our appId
//      and that covers the current contents fixes that; Gatekeeper then
//      treats it like any unsigned-developer app (right-click → Open, or
//      `xattr -dr com.apple.quarantine`, per README §Download).
//
// NB: signing must come AFTER the locale trim so the signature covers the
// final file set. On a dev machine whose checkout lives in iCloud Drive,
// codesign can fail on `com.apple.fileprovider` xattrs it cannot strip;
// CI runners are clean. Move the checkout out of iCloud for a local
// `make app`, or rely on CI for release artifacts.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const KEEP_LOCALES = new Set(["en.lproj", "en_GB.lproj", "Base.lproj"]);
const APP_ID = "io.coconote.shell";

module.exports = async function macPostprocess(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // 1. Trim Chromium locale packs.
  const res = path.join(
    app,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Resources",
  );
  let removed = 0;
  for (const entry of fs.readdirSync(res)) {
    if (entry.endsWith(".lproj") && !KEEP_LOCALES.has(entry)) {
      fs.rmSync(path.join(res, entry), { recursive: true, force: true });
      removed++;
    }
  }
  console.log(`  • mac_postprocess: removed ${removed} locale packs`);

  // 2. Ad-hoc re-sign over the final contents.
  execFileSync("xattr", ["-cr", app]);
  try {
    execFileSync("codesign", ["--remove-signature", app], { stdio: "ignore" });
  } catch { /* nothing to remove */ }
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--identifier", APP_ID, app],
    { stdio: "inherit" },
  );
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
      stdio: "inherit",
    });
  } catch (e) {
    console.error(
      "  ⨯ mac_postprocess: signature verify failed. If this checkout is " +
        "in iCloud Drive, codesign trips on com.apple.fileprovider xattrs " +
        "it cannot strip — build on CI or move the repo to a local path.",
    );
    throw e;
  }
  console.log("  • mac_postprocess: ad-hoc signed + verified");
};
