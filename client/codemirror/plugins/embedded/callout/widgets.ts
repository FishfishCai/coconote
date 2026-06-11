import { type EditorView, WidgetType } from "@codemirror/view";

// Title widget shown in place of the `::: keyword:label` opener line when
// the cursor is outside the callout. Click drops the cursor onto the
// opener so the raw source becomes editable.
export class CalloutPrefixWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly number: number | null,
    readonly cssClass: string,
    readonly openerPos: number,
    readonly label: string,
  ) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = `coconote-callout-prefix coconote-callout-${this.cssClass}-prefix`;
    const base = this.number != null
      ? `${this.title} ${this.number}`
      : this.title;
    const numbered = this.number != null;
    if (this.label) {
      el.textContent = `${base} (${this.label})${numbered ? "." : ""}`;
    } else {
      el.textContent = numbered ? `${base}.` : base;
    }
    el.style.cursor = "text";
    // mousedown beats the editor's default click handling.
    el.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      view.dispatch({ selection: { anchor: this.openerPos } });
      view.focus();
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
  override eq(other: WidgetType): boolean {
    return other instanceof CalloutPrefixWidget &&
      other.title === this.title &&
      other.number === this.number &&
      other.cssClass === this.cssClass &&
      other.openerPos === this.openerPos &&
      other.label === this.label;
  }
}

// Suffix glyph (currently only `∎` for proof). Floated right at end of the
// last body line — see callout.scss `.coconote-callout-proof-suffix`.
export class CalloutSuffixWidget extends WidgetType {
  constructor(readonly suffix: string, readonly cssClass: string) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `coconote-callout-suffix coconote-callout-${this.cssClass}-suffix`;
    el.textContent = this.suffix;
    return el;
  }
  override eq(other: WidgetType): boolean {
    return other instanceof CalloutSuffixWidget &&
      other.suffix === this.suffix &&
      other.cssClass === this.cssClass;
  }
}
