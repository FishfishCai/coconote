import { WidgetType } from "@codemirror/view";

// Placeholder rendered before the real widget is ready, so the editor
// doesn't flash raw widget source during boot.
export class LoadingWidget extends WidgetType {
  constructor(readonly block: boolean = false) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof LoadingWidget && other.block === this.block;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "coconote-loading-widget " +
      (this.block ? "coconote-loading-widget-block" : "coconote-loading-widget-inline");
    const spinner = document.createElement("span");
    spinner.className = "coconote-loading-spinner";
    wrapper.appendChild(spinner);
    return wrapper;
  }

  override get estimatedHeight(): number {
    return this.block ? 24 : -1;
  }
}
