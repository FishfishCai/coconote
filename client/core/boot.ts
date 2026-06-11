import "./uint8_base64_polyfill.ts";
import { safeRun } from "coconote/lib/async";
import {
  errMessage,
  notAuthenticatedError,
  offlineError,
} from "coconote/constants";
import { authedFetch, setAuthToken } from "../lib/authed_fetch.ts";
import { Client } from "./client.ts";
import { Config } from "./config.ts";
import type { BootConfig } from "../types/ui.ts";
import { readUserPrefs } from "../lib/user_prefs.ts";

const TOKEN_KEY = "coconote.authToken";

globalThis.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
});

// Suppress the native context menu app-wide (shell Back/Reload/Inspect,
// browser Print/Save). Capture phase, so preventDefault runs before any
// element handler. The spec-defined right-click handlers (PDF highlights,
// content-browser rows, ...) still receive the event and draw their own menus.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
}, true);

safeRun(async () => {
  // welcome.md: browser clients on remote instances present the auth
  // token, loopback desktop clients never need one. Seed the module
  // token from a previous login before the first request goes out.
  try {
    setAuthToken(localStorage.getItem(TOKEN_KEY) ?? undefined);
  } catch { /* private browsing */ }

  let bootConfig: BootConfig | undefined;
  try {
    const text = await cachedFetch(".config");
    bootConfig = JSON.parse(text);
  } catch (e: unknown) {
    if (errMessage(e) === notAuthenticatedError.message) {
      // Remote instance wants the `auth` value from its coconote.yaml.
      let hadToken = false;
      try {
        hadToken = !!localStorage.getItem(TOKEN_KEY);
        if (hadToken) localStorage.removeItem(TOKEN_KEY);
      } catch { /* private browsing */ }
      showTokenGate(
        hadToken
          ? "Token rejected - enter the server's current auth token."
          : "This server requires its auth token to continue.",
      );
      return;
    }
    if (errMessage(e) === offlineError.message) {
      alert(
        "Could not fetch boot config and no cached copy is available, please connect to the Internet",
      );
      return;
    }
  }

  const config = new Config();
  // Read-only vault flag (server-rs handlers/config.rs) makes the editor
  // read-only up front. Stored under `_boot.*` so Config stays the
  // single source of truth.
  config.set(["_boot", "readOnly"], bootConfig?.readOnly ?? false);

  // UI prefs live entirely in localStorage (the server ships no `ui`
  // block) - Settings edits persist without touching the yaml.
  const prefs = readUserPrefs();
  if (Object.keys(prefs).length > 0) config.set("ui", prefs);

  // Server-side snippet.json is the source of truth (editor.md Snippet):
  // it overrides any localStorage copy so file edits land without a
  // localStorage clear.
  if (bootConfig?.snippets) {
    const ui = { ...(config.get("ui") ?? {}), snippets: bootConfig.snippets };
    config.set("ui", ui);
  }

  // Strip ?query so refresh doesn't carry side-effect flags. replaceState
  // (not push): an extra history entry with `{}` state would later make
  // Back resolve to "no path" and bounce to the Content browser.
  if (location.search) {
    const newURL = new URL(location.href);
    newURL.search = "";
    history.replaceState(history.state, "", newURL.toString());
  }

  const client = new Client(
    document.getElementById("coconote-root")!,
    config,
  );
  globalThis.client = client;
  await client.init();
});

/** Minimal pre-app login surface (welcome.md: "Browser clients on
 *  remote instances enter this value at login"). Inline-styled so it
 *  needs nothing from the app bundle's CSS to render. */
function showTokenGate(message: string): void {
  const root = document.getElementById("coconote-root");
  if (!root) return;
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
    "height:100vh;gap:14px;font-family:system-ui,sans-serif;";
  const h = document.createElement("h1");
  h.textContent = "Coconote";
  const p = document.createElement("p");
  p.textContent = message;
  p.style.cssText = "opacity:.75;max-width:30rem;text-align:center;margin:0;";
  const form = document.createElement("form");
  form.style.cssText = "display:flex;gap:8px;";
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "auth token";
  input.autofocus = true;
  input.style.cssText = "padding:6px 10px;font-size:1rem;";
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.textContent = "Unlock";
  btn.style.cssText = "padding:6px 14px;font-size:1rem;";
  form.append(input, btn);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    try {
      localStorage.setItem(TOKEN_KEY, v);
    } catch { /* private browsing - token lives for this load only */ }
    location.reload();
  });
  wrap.append(h, p, form);
  root.append(wrap);
}

async function cachedFetch(path: string): Promise<string> {
  const cacheKey = `coconote.${document.baseURI}.${path}`;
  try {
    const response = await authedFetch(path, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (response.status >= 500 && response.status < 600) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) return cached;
      throw offlineError;
    }
    if (response.status === 404) return "";
    // 401/403: never fall back to a cached copy - the API calls that
    // follow would all fail. Surface the token gate instead.
    if (response.status === 401 || response.status === 403) {
      throw notAuthenticatedError;
    }
    const redirectHeader = response.headers.get("location");
    if (response.type === "opaqueredirect" || redirectHeader) {
      if (redirectHeader) {
        location.href = redirectHeader;
      } else {
        location.reload();
      }
      throw notAuthenticatedError;
    }
    const text = await response.text();
    localStorage.setItem(cacheKey, text);
    return text;
  } catch (e: unknown) {
    if (errMessage(e) === notAuthenticatedError.message) throw e;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;
    throw e;
  }
}
