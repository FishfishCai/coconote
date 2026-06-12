import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, Ref } from "preact";
import { Modal } from "./modal.tsx";

export function Prompt({
  message,
  defaultValue,
  callback,
}: {
  message: string;
  defaultValue: string;
  callback: (value?: string) => void;
}) {
  const [text, setText] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <Modal size="small" onClose={() => callback()}>
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
    </Modal>
  );
}

export function Confirm({
  message,
  okOnly,
  callback,
}: {
  message: string;
  /** Notice mode: hide Cancel, the modal just informs. */
  okOnly?: boolean;
  callback: (value: boolean) => void;
}) {
  const okButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okButtonRef.current?.focus();
  }, []);
  const returnEl = (
    <Modal
      size="small"
      onClose={() => {
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
          {!okOnly && (
            <Button
              onActivate={() => {
                callback(false);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Modal>
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

