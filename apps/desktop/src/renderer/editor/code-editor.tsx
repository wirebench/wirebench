/**
 * The one Monaco wrapper: a language, the Wirebench theme and the shared options.
 *
 * Every editor in the app goes through it — the SOAP envelope panes via {@link XmlEditor}, a REST
 * raw body via its own language — so no two editors can drift apart on font, theme, word wrap or
 * the accessible name Monaco puts on its hidden textarea.
 */
import { Editor } from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import { useMemo } from 'react';
import type * as Monaco from 'monaco-editor';
import { useResolvedTheme } from '../lib/theme.js';
import { getMarkerApi, setMarkerApi } from './markers.js';
import { usePreferencesStore } from '../state/preferences.js';
import { useUiStore } from '../state/ui.js';
import { BASE_EDITOR_OPTIONS, configureMonaco, monacoThemeName, XML_LANGUAGE_ID } from './monaco.js';

// Monaco's loader must be pointed at the bundled copy (and its languages registered) before the
// first editor mounts, and this module is only ever reached through a lazily-loaded editor, so
// import time is the right moment — `beforeMount` would already be too late for `loader.config`.
configureMonaco();

/** The Monaco language id for JSON, registered by `configureMonaco`. */
const JSON_LANGUAGE_ID = 'json';

/**
 * The languages an editor may ask for. `text` is Monaco's built-in plaintext; `html` and
 * `javascript` fall back to it, because this build carries no grammar for either and a body in one
 * of them is rare enough that a missing colour beats another bundled language service.
 */
export type EditorLanguage = 'xml' | 'json' | 'text' | 'html' | 'javascript';

/** The Monaco language id for one of ours. */
export function monacoLanguageId(language: EditorLanguage): string {
  if (language === 'xml') {
    return XML_LANGUAGE_ID;
  }
  return language === 'json' ? JSON_LANGUAGE_ID : 'plaintext';
}

export interface CodeEditorProps {
  readonly value: string;
  readonly language: EditorLanguage;
  readonly onChange?: (value: string) => void;
  readonly readOnly?: boolean;
  /** The accessible name Monaco puts on its hidden textarea — how tests and AT address the editor. */
  readonly ariaLabel: string;
  readonly onMount?: OnMount;
  /** Whether to show the gutter line-number column. Defaults to `true`. */
  readonly lineNumbers?: boolean;
  /** Whether Monaco shows its own right-click menu. Defaults to `true`. */
  readonly contextMenu?: boolean;
}

/** A Monaco editor in `language`. */
export function CodeEditor({
  value,
  language,
  onChange,
  readOnly = false,
  ariaLabel,
  onMount,
  lineNumbers = true,
  contextMenu = true,
}: CodeEditorProps) {
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
      language={monacoLanguageId(language)}
      theme={theme}
      value={value}
      options={options}
      {...(onChange !== undefined ? { onChange: (next?: string) => onChange(next ?? '') } : {})}
      onMount={(editor, monacoNS) => {
        // The first editor to mount hands the Monaco namespace to `editor/markers.ts`, so the
        // Problems view and the e2e handle work whichever protocol's editor opened first — the SOAP
        // request pane used to be the only one that did, and a REST or gRPC session had none.
        if (getMarkerApi() === undefined) {
          setMarkerApi(monacoNS as typeof Monaco);
        }
        onMount?.(editor, monacoNS);
      }}
      loading={<span className="p-3 text-sm text-fg-subtle">Loading editor…</span>}
    />
  );
}
