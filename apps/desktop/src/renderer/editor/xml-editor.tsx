/**
 * The XML editor both SOAP panes use: {@link CodeEditor} fixed to the XML language.
 *
 * Kept as its own component because every caller in the SOAP editor means "the envelope editor",
 * and because its props are the ones those callers already pass.
 */
import type { OnMount } from '@monaco-editor/react';
import { CodeEditor } from './code-editor.js';

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

/** A Monaco editor in the XML language, with the Wirebench theme and the shared options. */
export function XmlEditor(props: XmlEditorProps) {
  return <CodeEditor {...props} language="xml" />;
}
