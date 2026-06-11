// Free-text font-family stack input. The box is pre-filled with the
// effective font: the user's override if set, otherwise the live theme
// default (read from CSS, so it always matches what's actually rendering).
// Clearing the box — or the reset button — drops the override.

import { SettingRow } from "./setting_row.tsx";

export function FontRow(props: {
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
          type="text"
          className="coconote-font-input"
          value={current}
          onInput={(e) => props.onChange(e.currentTarget.value)}
        />
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
