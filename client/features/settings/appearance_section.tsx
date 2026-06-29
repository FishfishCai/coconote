import type { AppViewState } from "../../types/ui.ts";
import { useEffect, useMemo, useState } from "preact/hooks";
import { OverrideRow, SettingRow, SettingToggle } from "./setting_row.tsx";

type UiOptions = AppViewState["uiOptions"];

// Normalize any CSS colour string (#hex / rgb[a]() / hsl[a]()) to the
// #rrggbb the native <input type="color"> needs - it rejects rgb()/hsl()
// syntax and alpha. The canvas 2d context reuses the browser's own colour
// parser, so this stays correct for every theme token without a hand-rolled
// hsl/rgb converter.
function toHex(input: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(input)) return input.toLowerCase();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return "#000000";
  ctx.fillStyle = "#000000";
  ctx.fillStyle = input; // an unparseable value leaves the #000000 default
  const v = ctx.fillStyle; // "#rrggbb" when opaque, else "rgba(r, g, b, a)"
  if (v.charAt(0) === "#") return v;
  const nums = v.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return "#000000";
  const h = (n: string) => Math.round(Number(n)).toString(16).padStart(2, "0");
  return `#${h(nums[0])}${h(nums[1])}${h(nums[2])}`;
}

// Read the live theme defaults for the colour swatches, the same way the font
// inputs read --font-*-theme: the "reset to default" swatch then shows the
// CURRENT theme's default (dark vs light) instead of a hardcoded light hex.
// Each override row writes the live --accent-*/--editor-* var inline, so we
// read the colour's underlying theme token (the one the overrides never
// touch) and normalize it for the colour input.
function readThemeColors() {
  const cs = getComputedStyle(document.documentElement);
  const read = (v: string) => cs.getPropertyValue(v).trim();
  return {
    accent: toHex(`hsl(${read("--accent-h")}, ${read("--accent-s")}, ${
      read("--accent-l")
    })`),
    highlight: toHex(read("--text-highlight-bg")),
    linkMissing: toHex(read("--color-red")),
    codeBg: toHex(read("--editor-code-background-color")),
    hoverBg: toHex(read("--color-base-25")),
  };
}

export function AppearanceSection(props: {
  uiOptions: UiOptions;
  set: (k: string, v: unknown) => void;
}) {
  const { uiOptions, set } = props;
  // Read the live theme font stacks (styles/theme.scss --font-*-theme) so the
  // inputs show the real current default instead of a hardcoded, drifting copy.
  const themeFonts = useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = (v: string) => cs.getPropertyValue(v).trim();
    return {
      text: read("--font-text-theme"),
      interface: read("--font-interface-theme"),
      monospace: read("--font-monospace-theme"),
    };
  }, []);

  // Dark mode flips data-theme on <html> in useAppearance (a parent effect,
  // so it lands AFTER this child renders). Defer the re-read one frame so the
  // swatches pick up the new theme's defaults instead of lagging a toggle.
  const [themeColors, setThemeColors] = useState(readThemeColors);
  useEffect(() => {
    const id = requestAnimationFrame(() => setThemeColors(readThemeColors()));
    return () => cancelAnimationFrame(id);
  }, [uiOptions.darkMode]);
  return (
    <section>
      <h2>Appearance</h2>

      <SettingToggle
        id="coconote-dark"
        label="Dark mode"
        checked={!!uiOptions.darkMode}
        onChange={(v) => set("darkMode", v)}
      />

      <SettingRow
        htmlFor="coconote-font"
        label={
          <>
            Font size{" "}
            <span className="coconote-value">{uiOptions.fontSize}px</span>
          </>
        }
      >
        <input
          id="coconote-font"
          type="range"
          min={12}
          max={28}
          step={1}
          value={uiOptions.fontSize}
          onInput={(e) => set("fontSize", Number(e.currentTarget.value))}
        />
      </SettingRow>

      <SettingRow
        htmlFor="coconote-width"
        label={
          <>
            Content width{" "}
            <span className="coconote-value">{uiOptions.editorWidth}rem</span>
          </>
        }
      >
        <input
          id="coconote-width"
          type="range"
          min={28}
          max={80}
          step={1}
          value={uiOptions.editorWidth}
          onInput={(e) => set("editorWidth", Number(e.currentTarget.value))}
        />
      </SettingRow>

      <OverrideRow
        variant="color"
        label="Accent"
        defaultValue={themeColors.accent}
        value={uiOptions.accentColor}
        onChange={(v) => set("accentColor", v)}
      />
      <OverrideRow
        variant="color"
        label="Highlight"
        defaultValue={themeColors.highlight}
        value={uiOptions.highlightColor}
        onChange={(v) => set("highlightColor", v)}
      />
      <OverrideRow
        variant="color"
        label="Missing link"
        defaultValue={themeColors.linkMissing}
        value={uiOptions.linkMissingColor}
        onChange={(v) => set("linkMissingColor", v)}
      />
      <OverrideRow
        variant="color"
        label="Code background"
        defaultValue={themeColors.codeBg}
        value={uiOptions.codeBackgroundColor}
        onChange={(v) => set("codeBackgroundColor", v)}
      />
      <OverrideRow
        variant="color"
        label="Hover background"
        defaultValue={themeColors.hoverBg}
        value={uiOptions.hoverBackgroundColor}
        onChange={(v) => set("hoverBackgroundColor", v)}
      />

      <OverrideRow
        variant="text"
        label="Prose font"
        defaultValue={themeFonts.text}
        value={uiOptions.fontText}
        onChange={(v) => set("fontText", v)}
      />
      <OverrideRow
        variant="text"
        label="UI font"
        defaultValue={themeFonts.interface}
        value={uiOptions.fontInterface}
        onChange={(v) => set("fontInterface", v)}
      />
      <OverrideRow
        variant="text"
        label="Monospace font"
        defaultValue={themeFonts.monospace}
        value={uiOptions.fontMonospace}
        onChange={(v) => set("fontMonospace", v)}
      />
    </section>
  );
}
