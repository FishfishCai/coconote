export type ClickEvent = {
  /** The current page's file id (informational - navigation uses `pos`). */
  page: string;
  pos: number;
  // altKey routes the click to place-cursor instead of navigate.
  altKey: boolean;
};
