export type ClickEvent = {
  page: string;
  pos: number;
  // altKey routes the click to place-cursor instead of navigate.
  altKey: boolean;
  // Cmd/Ctrl+Click -> open in a new tab / window (editor.md Shortcuts).
  newTab?: boolean;
};
