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
  KeyMod: { CtrlCmd: 2048, Shift: 1024 },
  KeyCode: { Enter: 3, KeyF: 33 },
};

/** Must match `editor/monaco.ts`'s `SEND_KEYBINDING`. */
const SEND_KEYBINDING = fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.Enter;

/** Must match `editor/monaco.ts`'s `FORMAT_KEYBINDING`. */
const FORMAT_KEYBINDING = fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyMod.Shift | fakeMonaco.KeyCode.KeyF;

type Handler = () => void;

/** Lines the read-only viewers asked to reveal, newest last; reset it in a test's `beforeEach`. */
export const revealedLines: number[] = [];

export interface MockEditorProps {
  readonly value?: string;
  readonly onChange?: (value: string | undefined) => void;
  readonly options?: { readonly readOnly?: boolean; readonly ariaLabel?: string };
  readonly onMount?: (editor: { addCommand: (binding: number, handler: Handler) => void }, monaco: unknown) => void;
}

export function Editor({ value = '', onChange, options, onMount }: MockEditorProps) {
  const commands = useRef(new Map<number, Handler>());
  const mountRef = useRef(onMount);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  mountRef.current = onMount;
  valueRef.current = value;
  onChangeRef.current = onChange;

  useEffect(() => {
    const mockEditor = {
      addCommand: (binding: number, handler: Handler) => commands.current.set(binding, handler),
      getModel: () => ({
        getValue: () => valueRef.current,
        getFullModelRange: () => ({}),
      }),
      executeEdits: (source: string, edits: readonly { readonly range?: unknown; readonly text: string }[]) => {
        if (edits.length > 0) {
          const newValue = edits[0]?.text ?? '';
          valueRef.current = newValue;
          onChangeRef.current?.(newValue);
        }
      },
      getPosition: () => null,
      setPosition: () => undefined,
      revealLineInCenter: (line: number) => {
        revealedLines.push(line);
      },
    };
    mountRef.current?.(mockEditor, fakeMonaco);
  }, []);

  return (
    <textarea
      aria-label={options?.ariaLabel ?? 'editor'}
      readOnly={options?.readOnly ?? false}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          const handler = commands.current.get(SEND_KEYBINDING);
          if (handler !== undefined) {
            event.preventDefault();
            handler();
          }
        } else if ((event.key === 'f' || event.key === 'F') && (event.metaKey || event.ctrlKey) && event.shiftKey) {
          const handler = commands.current.get(FORMAT_KEYBINDING);
          if (handler !== undefined) {
            event.preventDefault();
            handler();
          }
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
