/**
 * The Interface editor's WSDL Content tab: every document of the resolved import graph on the
 * left, its text in a read-only Monaco on the right. The list (`definition.documents`) carries
 * no text; the selected document's source is fetched on its own (`definition.documentText`) and
 * cached per location, so a big import graph never crosses the bridge in one payload. Monaco's
 * own find widget is the "search within", so there is no second search UI here.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { Button } from '../../components/button.js';
import { XmlEditor } from '../../editor/xml-editor.js';
import { formatBytes } from '../../lib/format-size.js';
import { NO_DOCUMENTS, useInterfaceEditorStore } from './interface-editor-state.js';

export interface WsdlContentTabProps {
  readonly interfaceId: string;
}

/** The last path segment of a location, which is what identifies a document at a glance. */
export function documentLabel(location: string): string {
  const withoutQuery = location.split(/[?#]/)[0] ?? location;
  const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? location : last;
}

export function WsdlContentTab({ interfaceId }: WsdlContentTabProps) {
  const data = useInterfaceEditorStore((state) => state.data[interfaceId]);
  const target = useInterfaceEditorStore((state) => state.sourceTargets[interfaceId]);
  const clearSourceTarget = useInterfaceEditorStore((state) => state.clearSourceTarget);
  const loadText = useInterfaceEditorStore((state) => state.loadText);
  const [index, setIndex] = useState(0);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const documents = data?.documents?.documents ?? NO_DOCUMENTS;
  const current = documents[Math.min(index, Math.max(0, documents.length - 1))];
  const location = current?.location;
  const text = useInterfaceEditorStore((state) =>
    location === undefined ? undefined : state.data[interfaceId]?.texts?.[location],
  );

  // Only the document actually on screen is fetched, and only once per location.
  useEffect(() => {
    if (location !== undefined) {
      void loadText(interfaceId, location);
    }
  }, [loadText, interfaceId, location]);

  // A "Go to source" from the Schema tab names a document and a line: select that document,
  // then reveal the line once the editor holding it is mounted.
  useEffect(() => {
    if (target === undefined) {
      return;
    }
    const found = documents.findIndex((document) => document.location === target.location);
    if (found !== -1) {
      setIndex(found);
    }
  }, [target, documents]);

  const reveal = useCallback((line: number | undefined) => {
    const editor = editorRef.current;
    if (editor === undefined || line === undefined || typeof editor.revealLineInCenter !== 'function') {
      return;
    }
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
  }, []);

  // Revealing is a one-shot: once the line is on screen the target is dropped, so stepping
  // Prev/Next away and back does not jump the caret to a line the user has since left.
  useEffect(() => {
    if (target === undefined || text === undefined) {
      return;
    }
    if (location !== target.location) {
      return;
    }
    reveal(target.line);
    clearSourceTarget(interfaceId);
  }, [reveal, target, text, location, clearSourceTarget, interfaceId]);

  const handleMount = useCallback<OnMount>(
    (editor) => {
      editorRef.current = editor;
      reveal(target?.line);
    },
    [reveal, target],
  );

  if (data?.status === 'loading' || data === undefined) {
    return <p className="p-4 text-md text-fg-muted">Loading documents…</p>;
  }
  if (documents.length === 0) {
    return (
      <p data-testid="wsdl-content-empty" className="p-4 text-md text-fg-muted">
        {data.error ?? 'This definition has no cached documents.'}
      </p>
    );
  }

  return (
    <div data-testid="wsdl-content" className="flex h-full min-h-0">
      <div className="flex w-72 shrink-0 flex-col border-r border-hairline">
        <div className="flex shrink-0 items-center gap-1 border-b border-hairline p-1">
          <Button
            data-testid="wsdl-document-prev"
            disabled={index <= 0}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
          >
            Previous
          </Button>
          <Button
            data-testid="wsdl-document-next"
            disabled={index >= documents.length - 1}
            onClick={() => setIndex((value) => Math.min(documents.length - 1, value + 1))}
          >
            Next
          </Button>
        </div>
        <ul aria-label="Definition documents" data-testid="wsdl-document-list" className="min-h-0 flex-1 overflow-auto">
          {documents.map((document, position) => (
            <li key={document.location}>
              <button
                type="button"
                data-testid="wsdl-document-item"
                data-location={document.location}
                aria-pressed={position === index}
                onClick={() => setIndex(position)}
                className={`flex w-full flex-col items-start px-2 py-1 text-left ${
                  position === index ? 'bg-accent-muted text-fg-default' : 'text-fg-muted hover:bg-surface-raised'
                }`}
              >
                <span className="w-full truncate text-sm">{documentLabel(document.location)}</span>
                <span className="w-full truncate text-xs text-fg-faint">
                  {document.kind.toUpperCase()} · {formatBytes(document.size)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <p
          data-testid="wsdl-document-location"
          className="truncate border-b border-hairline px-2 py-1 text-xs text-fg-subtle"
        >
          {current?.location ?? ''}
        </p>
        <div className="min-h-0 flex-1">
          <XmlEditor
            ariaLabel="Definition document XML"
            value={text ?? ''}
            readOnly
            onMount={handleMount}
            key={location ?? ''}
          />
        </div>
      </div>
    </div>
  );
}
