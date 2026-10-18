import { useEffect, useState } from 'react';

/** An optional button on a toast, for the one action that undoes (or overrides) what it reports. */
export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly action?: ToastAction;
}

type Listener = (toasts: readonly Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: readonly Toast[] = [];
let nextId = 1;

const TOAST_DURATION_MS = 3200;

/** A toast offering an action stays up longer: the user has to read it and decide. */
const ACTION_TOAST_DURATION_MS = 8000;

function publish(next: readonly Toast[]): void {
  toasts = next;
  for (const listener of listeners) {
    listener(toasts);
  }
}

/**
 * Takes a toast down before its time, for one whose message stopped being true. An id already gone
 * is ignored.
 *
 * @param id what {@link showToast} returned
 */
export function dismissToast(id: number): void {
  if (toasts.some((toast) => toast.id === id)) {
    publish(toasts.filter((toast) => toast.id !== id));
  }
}

/**
 * Shows a transient message. Module-level so commands can call it without React context.
 *
 * @param message what to say
 * @param action an optional single button; clicking it runs `onClick` and dismisses the toast
 * @returns the toast's id, for {@link dismissToast}
 */
export function showToast(message: string, action?: ToastAction): number {
  const id = nextId++;
  publish([...toasts, { id, message, ...(action !== undefined ? { action } : {}) }]);
  setTimeout(
    () => {
      dismissToast(id);
    },
    action === undefined ? TOAST_DURATION_MS : ACTION_TOAST_DURATION_MS,
  );
  return id;
}

/** The live region toasts appear in; mounted once by the shell. */
export function ToastViewport() {
  const [visible, setVisible] = useState<readonly Toast[]>(toasts);

  useEffect(() => {
    listeners.add(setVisible);
    return () => {
      listeners.delete(setVisible);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast-viewport"
      className="pointer-events-none fixed right-4 bottom-8 z-toast flex flex-col items-end gap-2"
    >
      {visible.map((toast) => (
        <div
          key={toast.id}
          className="flex items-center gap-3 rounded-md border border-hairline bg-surface-overlay px-3 py-2 text-md text-fg-default shadow-lg"
        >
          <span>{toast.message}</span>
          {toast.action !== undefined && (
            <button
              type="button"
              data-testid="toast-action"
              className="pointer-events-auto shrink-0 rounded-sm border border-hairline px-2 py-0.5 text-sm text-fg-default hover:bg-surface-hover"
              onClick={() => {
                const action = toast.action;
                dismissToast(toast.id);
                action?.onClick();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
