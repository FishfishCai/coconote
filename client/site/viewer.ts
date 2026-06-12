// Entry point of the exported site's viewer bundle (assets/site.js,
// built as a self-contained IIFE by build/build_client.ts so it loads
// with a plain <script> from file://). Reads window.COCONOTE_SITE
// (assets/manifest.js, loaded before this script) and the shell's
// `data-view`, renders the matching view into #site-root. Never
// fetches anything at runtime.

import { h, render } from "preact";
import { readManifest, type SiteView } from "./manifest.ts";
import { SiteApp } from "./site_app.tsx";

function boot(): void {
  const root = document.getElementById("site-root");
  if (!root) return;
  const attr = root.getAttribute("data-view");
  const view: SiteView = attr === "tag" || attr === "graph" ? attr : "path";
  const pages = readManifest()?.pages ?? [];
  render(h(SiteApp, { view, pages }), root);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
