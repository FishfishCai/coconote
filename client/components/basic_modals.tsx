import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, Ref } from "preact";

export function Prompt({
  message,
  defaultValue,
  darkMode: _darkMode,
  callback,
}: {
  message: string;
  defaultValue?: string;
  darkMode: boolean | undefined;
  callback: (value?: string) => void;
}) {
  const [text, setText] = useState(defaultValue || "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <AlwaysShownModal onCancel={() => callback()}>
      <div className="coconote-prompt">
        <label>
          {message}
          <input
            ref={inputRef}
            type="text"
            value={text}
            onInput={(e) => setText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                callback(text);
              } else if (e.key === "Escape") {
                e.preventDefault();
                callback();
              }
            }}
          />
        </label>
        <div className="coconote-prompt-buttons">
          <Button primary onActivate={() => callback(text)}>Ok</Button>
          <Button onActivate={() => callback()}>Cancel</Button>
        </div>
      </div>
    </AlwaysShownModal>
  );
}

export function Confirm({
  message,
  callback,
}: {
  message: string;
  callback: (value: boolean) => void;
}) {
  const okButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okButtonRef.current?.focus();
  }, []);
  const returnEl = (
    <AlwaysShownModal
      onCancel={() => {
        callback(false);
      }}
    >
      <div className="coconote-prompt">
        <label>{message}</label>
        <div className="coconote-prompt-buttons">
          <Button
            buttonRef={okButtonRef}
            primary={true}
            onActivate={() => {
              callback(true);
            }}
          >
            Ok
          </Button>
          <Button
            onActivate={() => {
              callback(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    </AlwaysShownModal>
  );

  return returnEl;
}

export function Button({
  children,
  primary,
  onActivate,
  buttonRef,
}: {
  children: ComponentChildren;
  primary?: boolean;
  onActivate: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={primary ? "coconote-button-primary" : "coconote-button"}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onActivate();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
    </button>
  );
}

export function AlwaysShownModal({
  children,
  onCancel,
}: {
  children: ComponentChildren;
  onCancel?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.style.opacity = "0";
      dialog.showModal();

      // Safari: CodeMirror's flex sizing inside <dialog> needs one
      // extra reflow. Toggle display after first paint; keep the
      // dialog hidden until then to suppress the visible jump.
      const fixSafariLayout = () => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            dialog.style.display = "flex";
            void dialog.offsetHeight;
            dialog.style.display = "";
            dialog.style.opacity = "";
          });
        });
      };

      if (dialog.querySelector(".cm-editor")) {
        fixSafariLayout();
      } else {
        const observer = new MutationObserver(() => {
          if (dialog.querySelector(".cm-editor")) {
            observer.disconnect();
            fixSafariLayout();
          }
        });
        observer.observe(dialog, { childList: true, subtree: true });
        // Reveal even if no .cm-editor appears (e.g. Confirm dialogs).
        setTimeout(() => {
          observer.disconnect();
          dialog.style.opacity = "";
        }, 500);
      }
    }
  }, []);

  return (
    <dialog
      className="coconote-modal-box"
      onCancel={(e: Event) => {
        e.preventDefault();
        onCancel?.();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
      }}
      ref={dialogRef}
    >
      {children}
    </dialog>
  );
}
