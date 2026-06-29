// Shared settings primitives, extracted so a CSS/a11y tweak applies to
// every settings section at once.

import type { ComponentChildren } from "preact";

type RowProps = {
  htmlFor?: string;
  label: ComponentChildren;
  children: ComponentChildren;
};

export function SettingRow({ htmlFor, label, children }: RowProps) {
  return (
    <div className="coconote-setting-row">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

type ToggleProps = {
  id: string;
  label: ComponentChildren;
  checked: boolean;
  onChange(next: boolean): void;
};

export function SettingToggle({
  id,
  label,
  checked,
  onChange,
}: ToggleProps) {
  return (
    <SettingRow htmlFor={id} label={label}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-pressed={checked}
        className={"coconote-toggle " + (checked ? "on" : "")}
        onClick={() => onChange(!checked)}
      >
        <span className="coconote-toggle-knob" />
      </button>
    </SettingRow>
  );
}

type OverrideProps = {
  label: string;
  /** Theme default shown (and submitted on edit) when there is no override. */
  defaultValue: string;
  /** The user's override, or "" to fall back to defaultValue. */
  value: string;
  onChange(next: string): void;
  variant: "color" | "text";
};

// First family of a CSS font stack, unquoted - what a single-font setting
// shows as its placeholder default.
function primaryFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

// One "value with a theme default + reset" row, shared by the colour and
// font settings. Empty value means "use the default", reset clears the
// override. The colour swatch speaks for itself (no hex text); the font is a
// single typeface (commas - i.e. multi-font stacks - are stripped).
export function OverrideRow(
  { label, defaultValue, value, onChange, variant }: OverrideProps,
) {
  return (
    <SettingRow label={label}>
      <div className="coconote-color-row">
        {variant === "color"
          ? (
            <input
              type="color"
              value={value || defaultValue}
              onInput={(e) => onChange(e.currentTarget.value)}
            />
          )
          : (
            <input
              type="text"
              className="coconote-font-input"
              value={value}
              placeholder={primaryFamily(defaultValue)}
              onInput={(e) => onChange(e.currentTarget.value.replace(/,/g, ""))}
            />
          )}
        {value && (
          <button
            type="button"
            className="coconote-color-reset"
            onClick={() => onChange("")}
            title="Reset to default"
          >
            reset
          </button>
        )}
      </div>
    </SettingRow>
  );
}
