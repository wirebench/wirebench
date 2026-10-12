import { useEffect, useRef, useState } from 'react';
import { nameError } from './format.js';

/**
 * An entry's name as a field: Enter renames (an empty name or one with `/` is refused and the field stays),
 * Escape or leaving the field keeps the old name. The part before the extension starts selected.
 */
export function RenameField({
  name,
  onCommit,
  onCancel,
}: {
  readonly name: string;
  readonly onCommit: (to: string) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const error = nameError(text);

  useEffect(() => {
    const field = input.current;
    if (field === null) return;
    field.focus();
    const dot = name.lastIndexOf('.');
    field.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);

  return (
    <input
      ref={input}
      aria-label={`New name for ${name}`}
      data-testid="files-rename"
      aria-invalid={error !== undefined}
      title={error}
      value={text}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
      }}
      // The list's own keys (Enter opens, Backspace goes up, arrows move) must not see the field's.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (error !== undefined) return;
          if (text === name) onCancel();
          else onCommit(text);
        }
      }}
      onClick={(e) => {
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
      onBlur={onCancel}
      className="h-5 min-w-0 flex-1 rounded border border-accent bg-surface-sunken px-1 text-sm text-fg-default outline-none aria-invalid:border-status-danger"
    />
  );
}
