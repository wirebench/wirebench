import { useEffect, useState } from 'react';

interface Toast {
  readonly id: number;
  readonly message: string;
}

type Listener = (toasts: readonly Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: readonly Toast[] = [];
let nextId = 1;

const TOAST_DURATION_MS = 3200;

function publish(next: readonly Toast[]): void {
  toasts = next;
  for (const listener of listeners) {
    listener(toasts);
  }
}

/** Shows a transient message. Module-level so commands can call it without React context. */
export function showToast(message: string): void {
  const id = nextId++;
  publish([...toasts, { id, message }]);
  setTimeout(() => {
    publish(toasts.filter((toast) => toast.id !== id));
  }, TOAST_DURATION_MS);
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
      className="pointer-events-none fixed right-4 bottom-8 z-50 flex flex-col items-end gap-2"
    >
      {visible.map((toast) => (
        <div
          key={toast.id}
          className="rounded-md border border-hairline bg-surface-overlay px-3 py-2 text-md text-fg-default shadow-lg"
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
