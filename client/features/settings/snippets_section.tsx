import { useEffect, useState } from "preact/hooks";

export function SnippetsSection(props: {
  value: string;
  onChange: (v: string) => void;
}) {
  // Buffer the textarea locally, commit on blur (spec: snippet edits
  // persist only when the user leaves the field, not per keystroke).
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);
  return (
    <section>
      <h2>Snippets</h2>
      <div className="coconote-setting-row coconote-setting-row-block">
        <textarea
          id="coconote-snippets"
          aria-label="Snippets JSON"
          spellcheck={false}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => {
            // Read from the DOM target so a raw `ta.value=...;
            // dispatchEvent('blur')` sequence (no input event) still
            // commits.
            const v = e.currentTarget.value;
            if (v !== props.value) props.onChange(v);
          }}
          rows={10}
          placeholder={`[\n  { "trigger": "//", "replacement": "\\\\frac{$1}{$2}$0", "options": "mA" }\n]`}
        />
      </div>
    </section>
  );
}
