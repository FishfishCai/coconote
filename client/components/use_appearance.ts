import { useEffect } from "preact/hooks";
import type { AppViewState } from "../types/ui.ts";

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    s = d / (l > 0.5 ? 2 - max - min : max + min);
    if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: Math.round(hue), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Maps uiOptions to document-level CSS variables / attributes so
 *  setting.md appearance changes apply live (theme, sizes, colors, fonts). */
export function useAppearance(uiOptions: AppViewState["uiOptions"]): void {
  useEffect(() => {
    if (uiOptions.darkMode === undefined) return;
    document.documentElement.dataset.theme = uiOptions.darkMode ? "dark" : "light";
    // Persist so the inline <head> script in index.html avoids the
    // light->dark first-paint flash on next load.
    try {
      localStorage.setItem("coconote.darkMode", uiOptions.darkMode ? "1" : "0");
    } catch { /* ignore quota / disabled storage */ }
  }, [uiOptions.darkMode]);

  useEffect(() => {
    document.documentElement.dataset.editorMode = uiOptions.editorMode;
  }, [uiOptions.editorMode]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${uiOptions.fontSize}px`,
    );
  }, [uiOptions.fontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--editor-width",
      `${uiOptions.editorWidth}rem`,
    );
  }, [uiOptions.editorWidth]);

  // Empty string clears the override so the theme default re-applies.
  useEffect(() => {
    const root = document.documentElement;
    const set = (cssVar: string, value: string) => {
      if (value) root.style.setProperty(cssVar, value);
      else root.style.removeProperty(cssVar);
    };
    // Split accent hex -> HSL so the theme can derive hover/selection
    // shades by tweaking lightness.
    if (uiOptions.accentColor) {
      const hsl = hexToHsl(uiOptions.accentColor);
      if (hsl) {
        root.style.setProperty("--accent-h", String(hsl.h));
        root.style.setProperty("--accent-s", `${hsl.s}%`);
        root.style.setProperty("--accent-l", `${hsl.l}%`);
      }
    } else {
      root.style.removeProperty("--accent-h");
      root.style.removeProperty("--accent-s");
      root.style.removeProperty("--accent-l");
    }
    set("--editor-highlight-background-color", uiOptions.highlightColor);
    set("--editor-wiki-link-missing-color", uiOptions.linkMissingColor);
    // setting.md: "Code background" covers inline AND fenced blocks -
    // the stylesheet uses a separate var for block surfaces.
    set("--editor-code-background-color", uiOptions.codeBackgroundColor);
    set("--editor-code-block-background-color", uiOptions.codeBackgroundColor);
    // CSS uses --background-secondary-alt for button / settings-group /
    // content-browser hovers (setting.md "Hover background").
    set("--background-secondary-alt", uiOptions.hoverBackgroundColor);
    set("--font-text", uiOptions.fontText);
    set("--font-interface", uiOptions.fontInterface);
    set("--font-monospace", uiOptions.fontMonospace);
  }, [
    uiOptions.accentColor,
    uiOptions.highlightColor,
    uiOptions.linkMissingColor,
    uiOptions.codeBackgroundColor,
    uiOptions.hoverBackgroundColor,
    uiOptions.fontText,
    uiOptions.fontInterface,
    uiOptions.fontMonospace,
  ]);
}
