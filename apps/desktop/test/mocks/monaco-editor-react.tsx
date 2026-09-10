import { useEffect, useRef } from 'react';

/**
 * A `<textarea>` stand-in for `@monaco-editor/react`.
 *
 * Monaco needs real layout, `matchMedia`, and workers, none of which jsdom provides, so the
 * component tests swap it for this. It keeps the two behaviours the request editor actually
 * depends on: `value`/`onChange` round-tripping, and the ⌘⏎ keybinding registered in `onMount`.
 */

/** The subset of the Monaco API `@monaco-editor/react` hands to `onMount`, with real values. */
export const fakeMonaco = {
  KeyMod: { CtrlCmd: 2048 },
  KeyCode: { Enter: 3 },
};

/** Must match `editor/monaco.ts`'s `SEND_KEYBINDING`. */
const SEND_KEYBINDING = fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.Enter;

type Handler = () => void;

export interface MockEditorProps {
  readonly value?: string;
  readonly onChange?: (value: string | undefined) => void;
  readonly options?: { readonly readOnly?: boolean; readonly ariaLabel?: string };
  readonly onMount?: (editor: { addCommand: (binding: number, handler: Handler) => void }, monaco: unknown) => void;
}

export function Editor({ value = '', onChange, options, onMount }: MockEditorProps) {
  const commands = useRef(new Map<number, Handler>());
  const mountRef = useRef(onMount);
  mountRef.current = onMount;

  useEffect(() => {
    mountRef.current?.({ addCommand: (binding, handler) => commands.current.set(binding, handler) }, fakeMonaco);
  }, []);

  return (
    <textarea
      aria-label={options?.ariaLabel ?? 'editor'}
      readOnly={options?.readOnly ?? false}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) {
          return;
        }
        const handler = commands.current.get(SEND_KEYBINDING);
        if (handler !== undefined) {
          event.preventDefault();
          handler();
        }
      }}
    />
  );
}

export interface MockDiffEditorProps {
  readonly original?: string;
  readonly modified?: string;
  readonly options?: { readonly readOnly?: boolean; readonly renderSideBySide?: boolean };
}

/** A two-`<textarea>` stand-in for `@monaco-editor/react`'s `DiffEditor`. */
export function DiffEditor({ original = '', modified = '' }: MockDiffEditorProps) {
  return (
    <div>
      <textarea aria-label="Original" readOnly value={original} />
      <textarea aria-label="Modified" readOnly value={modified} />
    </div>
  );
}

export const loader = { config: () => undefined, init: () => Promise.resolve(fakeMonaco) };
export function useMonaco(): unknown {
  return fakeMonaco;
}

export default Editor;
