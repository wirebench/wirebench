import { DiffEditor } from '@monaco-editor/react';
import { useMemo } from 'react';
import { useResolvedTheme } from '../lib/theme.js';
import { useUiStore } from '../state/ui.js';
import { BASE_EDITOR_OPTIONS, configureMonaco, monacoThemeName, XML_LANGUAGE_ID } from './monaco.js';

configureMonaco();

export interface DiffXmlEditorProps {
  readonly original: string;
  readonly modified: string;
  readonly renderSideBySide: boolean;
  readonly ignoreTrimWhitespace: boolean;
  /** The Monaco language of both sides; XML unless given. */
  readonly language?: string;
}

/**
 * The one Monaco diff wrapper the History view's `diff` tab and the HTTP Log's compare use: read-only,
 * XML-languaged unless told otherwise,
 * themed like every other editor, with a side-by-side/inline toggle and a whitespace-ignore
 * toggle the diff tab's header drives.
 */
export function DiffXmlEditor({
  original,
  modified,
  renderSideBySide,
  ignoreTrimWhitespace,
  language,
}: DiffXmlEditorProps) {
  const preference = useUiStore((state) => state.theme);
  const theme = monacoThemeName(useResolvedTheme(preference));

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
      language={language ?? XML_LANGUAGE_ID}
      theme={theme}
      original={original}
      modified={modified}
      options={options}
      loading={<span className="p-3 text-sm text-fg-subtle">Loading editor…</span>}
    />
  );
}
