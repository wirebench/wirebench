import { DiffEditor } from '@monaco-editor/react';
import { useMemo } from 'react';
import { resolveTheme } from '../lib/theme.js';
import { useUiStore } from '../state/ui.js';
import { BASE_EDITOR_OPTIONS, configureMonaco, monacoThemeName, XML_LANGUAGE_ID } from './monaco.js';

configureMonaco();

export interface DiffXmlEditorProps {
  readonly original: string;
  readonly modified: string;
  readonly renderSideBySide: boolean;
  readonly ignoreTrimWhitespace: boolean;
}

/**
 * The one Monaco diff wrapper the History view's `diff` tab uses: read-only, XML-languaged,
 * themed like every other editor, with a side-by-side/inline toggle and a whitespace-ignore
 * toggle the diff tab's header drives.
 */
export function DiffXmlEditor({ original, modified, renderSideBySide, ignoreTrimWhitespace }: DiffXmlEditorProps) {
  const preference = useUiStore((state) => state.theme);
  const theme = monacoThemeName(resolveTheme(preference));

  const options = useMemo(
    () => ({
      ...BASE_EDITOR_OPTIONS,
      readOnly: true,
      domReadOnly: true,
      renderSideBySide,
      ignoreTrimWhitespace,
    }),
    [renderSideBySide, ignoreTrimWhitespace],
  );

  return (
    <DiffEditor
      language={XML_LANGUAGE_ID}
      theme={theme}
      original={original}
      modified={modified}
      options={options}
      loading={<span className="p-3 text-sm text-fg-subtle">Loading editor…</span>}
    />
  );
}
