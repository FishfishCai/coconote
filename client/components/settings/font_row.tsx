// Free-text font-family stack input. Empty value clears the inline override
// so the theme default re-applies; the placeholder hints at what the default
// looks like.

import { SettingRow } from "./setting_row.tsx";

export function FontRow(props: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <SettingRow label={props.label}>
      <input
        type="text"
        className="coconote-font-input"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onChange(e.currentTarget.value)}
      />
    </SettingRow>
  );
}
