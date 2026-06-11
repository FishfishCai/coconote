// Shared settings primitives — extracted so a CSS/a11y tweak applies
// to every settings section at once. Two primitives: SettingRow (the
// labelled `coconote-setting-row` wrapper used by the Appearance
// range / colour / font rows) and SettingToggle (switch-style boolean
// row built on top of it).

import type { ComponentChildren } from "preact";

type RowProps = {
  htmlFor?: string;
  label: ComponentChildren;
  hint?: ComponentChildren;
  children: ComponentChildren;
};

export function SettingRow({ htmlFor, label, hint, children }: RowProps) {
  return (
    <div className="coconote-setting-row">
      <label htmlFor={htmlFor}>
        {label}
        {hint && <span className="coconote-setting-hint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

type ToggleProps = {
  id: string;
  label: ComponentChildren;
  hint?: ComponentChildren;
  checked: boolean;
  onChange(next: boolean): void;
};

export function SettingToggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: ToggleProps) {
  return (
    <SettingRow htmlFor={id} label={label} hint={hint}>
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

// One "value with a theme default + reset" row, shared by the colour and
// font settings. Empty value means "use the default"; the input shows the
// effective value either way, and reset clears the override.
export function OverrideRow(
  { label, defaultValue, value, onChange, variant }: OverrideProps,
) {
  const current = value || defaultValue;
  return (
    <SettingRow label={label}>
      <div className="coconote-color-row">
        {variant === "color"
          ? (
            <>
              <input
                type="color"
                value={current}
                onInput={(e) => onChange(e.currentTarget.value)}
              />
              <span className="coconote-value">{current}</span>
            </>
          )
          : (
            <input
              type="text"
              className="coconote-font-input"
              value={current}
              onInput={(e) => onChange(e.currentTarget.value)}
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
