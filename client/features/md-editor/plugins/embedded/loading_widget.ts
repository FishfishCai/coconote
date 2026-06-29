import { WidgetType } from "@codemirror/view";

// Placeholder rendered before the real widget is ready, so the editor
// doesn't flash raw widget source during boot.
export class LoadingWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof LoadingWidget;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className =
      "coconote-loading-widget coconote-loading-widget-block";
    const spinner = document.createElement("span");
    spinner.className = "coconote-loading-spinner";
    wrapper.appendChild(spinner);
    return wrapper;
  }

  // Seed the same height MediaWidget falls back to (media_widget.ts: 200), so
  // swapping this block placeholder for the real media doesn't lurch the
  // heightMap (and the content below it) by ~176px on load.
  override get estimatedHeight(): number {
    return 200;
  }
}
