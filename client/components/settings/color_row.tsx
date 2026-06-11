// Color picker + "reset to default" button. value="" means use the theme
// default (no inline override); the picker still needs a non-empty value
// for the swatch, so we fall back to defaultValue while keeping the
// underlying state empty until the user actually picks.

import { SettingRow } from "./setting_row.tsx";

export function ColorRow(props: {
  label: string;
  defaultValue: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const current = props.value || props.defaultValue;
  return (
    <SettingRow label={props.label}>
      <div className="coconote-color-row">
        <input
          type="color"
          value={current}
          onInput={(e) => props.onChange(e.currentTarget.value)}
        />
        <span className="coconote-value">{current}</span>
        {props.value && (
          <button
            type="button"
            className="coconote-color-reset"
            onClick={() => props.onChange("")}
            title="Reset to default"
          >
            reset
          </button>
        )}
      </div>
    </SettingRow>
  );
}
