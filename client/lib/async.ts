export function safeRun(fn: () => Promise<void>): void {
  fn().catch((e) => {
    console.error(e);
  });
}
