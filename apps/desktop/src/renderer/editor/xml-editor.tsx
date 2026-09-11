import { Editor } from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { useMemo } from 'react';
import { useResolvedTheme } from '../lib/theme.js';
import { usePreferencesStore } from '../state/preferences.js';
import { useUiStore } from '../state/ui.js';
import { BASE_EDITOR_OPTIONS, configureMonaco, monacoThemeName, XML_LANGUAGE_ID } from './monaco.js';

// Monaco's loader must be pointed at the bundled copy before the first editor mounts, and this
// module is only ever reached through the lazily-loaded request editor, so import time is the
// right moment — `beforeMount` would already be too late for `loader.config`.
configureMonaco();

export interface XmlEditorProps {
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly readOnly?: boolean;
  /** The accessible name Monaco puts on its hidden textarea — how tests and AT address the editor. */
  readonly ariaLabel: string;
  readonly onMount?: OnMount;
  /** Whether to show the gutter line-number column. Defaults to `true`. */
  readonly lineNumbers?: boolean;
  /**
   * Whether Monaco shows its own right-click menu. Defaults to `true`; the request pane turns
   * it off so the pane's own `RequestContextMenu` (Recreate, cURL, Format…) gets the event.
   */
  readonly contextMenu?: boolean;
}

/**
 * The one Monaco wrapper: XML language, Wirebench theme, shared options. Both panes go through
 * it so the request and response editors can never drift apart.
 */
export function XmlEditor({
  value,
  onChange,
  readOnly = false,
  ariaLabel,
  onMount,
  lineNumbers = true,
  contextMenu = true,
}: XmlEditorProps) {
  const preference = useUiStore((state) => state.theme);
  const theme = monacoThemeName(useResolvedTheme(preference));
  const editorPreferences = usePreferencesStore((state) => state.preferences.editor);

  const options = useMemo(
    () => ({
      ...BASE_EDITOR_OPTIONS,
      ...(editorPreferences.fontFamily !== undefined && editorPreferences.fontFamily.length > 0
        ? { fontFamily: editorPreferences.fontFamily }
        : {}),
      fontSize: editorPreferences.fontSize,
      tabSize: editorPreferences.tabSize,
      wordWrap: editorPreferences.wordWrap ? ('on' as const) : ('off' as const),
      readOnly,
      domReadOnly: readOnly,
      ariaLabel,
      lineNumbers: lineNumbers ? ('on' as const) : ('off' as const),
      contextmenu: contextMenu,
    }),
    [readOnly, ariaLabel, lineNumbers, contextMenu, editorPreferences],
  );

  return (
    <Editor
      language={XML_LANGUAGE_ID}
      theme={theme}
      value={value}
      options={options}
      {...(onChange !== undefined ? { onChange: (next?: string) => onChange(next ?? '') } : {})}
      {...(onMount !== undefined ? { onMount } : {})}
      loading={<span className="p-3 text-sm text-fg-subtle">Loading editor…</span>}
    />
  );
}
