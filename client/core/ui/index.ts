// Shared UI primitives: the single <dialog>-based Modal base every panel
// builds on, its Cancel / confirm action bar, and the basic Prompt /
// Confirm / Button modals. Depends only on Preact.

export { Modal } from "./modal.tsx";
export type { ModalSize } from "./modal.tsx";
export { ModalActions } from "./modal_actions.tsx";
export { Button, Confirm, Prompt } from "./basic_modals.tsx";
