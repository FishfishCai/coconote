import type { AppViewState } from "../../types/ui.ts";
import { ColorRow } from "./color_row.tsx";
import { FontRow } from "./font_row.tsx";
import { SettingRow, SettingToggle } from "./setting_row.tsx";

type UiOptions = AppViewState["uiOptions"];

// "Reset to default" swatch values, kept in lockstep with the real
// theme defaults in styles/theme.scss (light palette):
//   accent     — hsl(254 80% 68%)            (--accent-h/s/l)
//   highlight  — rgba(255, 208, 0, 0.4) base (--text-highlight-bg)
//   missing    — #e93147 = var(--color-red)  (colors.scss fallback)
//   code bg    — #eceef1                     (--editor-code-background-color)
//   hover bg   — #e3e3e3 = --color-base-25   (--background-secondary-alt)
// The <input type=color> swatch can't carry alpha or hsl() syntax, so
// each is the equivalent #rrggbb.
const DEFAULT_ACCENT = "#8b6cef"; // hexToHsl → exactly (254, 80%, 68%)
const DEFAULT_HIGHLIGHT = "#ffd000";
const DEFAULT_LINK_MISSING = "#e93147";
const DEFAULT_CODE_BG = "#eceef1";
const DEFAULT_HOVER_BG = "#e3e3e3";

export function AppearanceSection(props: {
  uiOptions: UiOptions;
  set: (k: string, v: unknown) => void;
}) {
  const { uiOptions, set } = props;
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

      <ColorRow
        label="Accent"
        defaultValue={DEFAULT_ACCENT}
        value={uiOptions.accentColor}
        onChange={(v) => set("accentColor", v)}
      />
      <ColorRow
        label="Highlight"
        defaultValue={DEFAULT_HIGHLIGHT}
        value={uiOptions.highlightColor}
        onChange={(v) => set("highlightColor", v)}
      />
      <ColorRow
        label="Missing link"
        defaultValue={DEFAULT_LINK_MISSING}
        value={uiOptions.linkMissingColor}
        onChange={(v) => set("linkMissingColor", v)}
      />
      <ColorRow
        label="Code background"
        defaultValue={DEFAULT_CODE_BG}
        value={uiOptions.codeBackgroundColor}
        onChange={(v) => set("codeBackgroundColor", v)}
      />
      <ColorRow
        label="Hover background"
        defaultValue={DEFAULT_HOVER_BG}
        value={uiOptions.hoverBackgroundColor}
        onChange={(v) => set("hoverBackgroundColor", v)}
      />

      <FontRow
        label="Prose font"
        placeholder="CodeNewRoman Nerd Font, CodeNewRoman, sans-serif"
        value={uiOptions.fontText}
        onChange={(v) => set("fontText", v)}
      />
      <FontRow
        label="UI font"
        placeholder="Inter, system-ui, sans-serif"
        value={uiOptions.fontInterface}
        onChange={(v) => set("fontInterface", v)}
      />
      <FontRow
        label="Monospace font"
        placeholder="CodeNewRoman Nerd Font Mono, CodeNewRoman Mono, monospace"
        value={uiOptions.fontMonospace}
        onChange={(v) => set("fontMonospace", v)}
      />
    </section>
  );
}
