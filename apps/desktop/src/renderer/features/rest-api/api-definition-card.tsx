/**
 * The API tab's Definition card: where the document came from, and the documents themselves.
 *
 * Everything here is read from the cache main wrote at import time, never re-fetched: an API that
 * was imported without caching says so and offers nothing, which is honest — the alternative is a
 * "View document" button that quietly goes to the network, on a definition that may no longer be
 * there. The list carries identity and size only; a document's text is fetched when it is selected,
 * so a definition split across many files never crosses the bridge in one payload.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { ReadOnlySetting } from '../../components/settings-grid.js';
import { formatBytes } from '../../lib/format-size.js';
import { ipc } from '../../state/ipc-client.js';
import { showToast } from '../../components/toast.js';
import type { ApiDefinitionDocumentsResponse, RestApiWire } from '../../../shared/wire-types.js';

const CodeEditor = lazy(async () => ({ default: (await import('../../editor/code-editor.js')).CodeEditor }));

/** The last path segment of a location, which is what identifies a document at a glance. */
export function definitionDocumentLabel(location: string): string {
  const withoutQuery = location.split(/[?#]/)[0] ?? location;
  const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  return last === undefined || last.length === 0 ? location : last;
}

/**
 * The editor language for a document, by its own extension.
 *
 * A `.json` document is JSON; anything else (a `.yaml`, or a location with no extension at all) is
 * shown as plain text, because this build carries no YAML grammar and a wrong one would mis-colour
 * every line rather than none.
 */
export function definitionLanguage(location: string): 'json' | 'text' {
  return /\.json(?:[?#]|$)/i.test(location) ? 'json' : 'text';
}

export interface ApiDefinitionCardProps {
  readonly apiId: string;
  readonly definition: NonNullable<RestApiWire['definition']>;
}

/** One API's definition: its source, and a viewer over the documents it was made of. */
export function ApiDefinitionCard({ apiId, definition }: ApiDefinitionCardProps) {
  const [documents, setDocuments] = useState<ApiDefinitionDocumentsResponse | undefined>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [text, setText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [viewing, setViewing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(undefined);
    const result = await ipc().api.definitionDocuments({ apiId });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setDocuments(result.value);
    setSelected(result.value.rootLocation);
  }, [apiId]);

  // The text of whatever is selected, fetched on its own and replaced when the selection moves.
  useEffect(() => {
    if (!viewing || selected === undefined) {
      return;
    }
    let live = true;
    setText(undefined);
    void ipc()
      .api.definitionText({ apiId, location: selected })
      .then((result) => {
        if (!live) {
          return;
        }
        if (result.ok) {
          setText(result.value.text);
        } else {
          setError(result.error.message);
        }
      });
    return () => {
      live = false;
    };
  }, [apiId, selected, viewing]);

  async function onView(): Promise<void> {
    if (viewing) {
      setViewing(false);
      return;
    }
    setViewing(true);
    if (documents === undefined) {
      await load();
    }
  }

  async function onExport(): Promise<void> {
    const result = await ipc().api.exportDefinition({ apiId });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    if (result.value.cancelled) {
      return;
    }
    showToast(`Exported ${String(result.value.files.length)} document${result.value.files.length === 1 ? '' : 's'}.`);
  }

  return (
    <div data-testid="api-definition-card" className="flex flex-col gap-1">
      <ReadOnlySetting label="Source" value={definition.source} testId="api-definition-source" />
      <ReadOnlySetting label="Version" value={definition.version} />
      <ReadOnlySetting label="Cached" value={definition.cache ? 'yes' : 'no'} />
      {definition.cache ? (
        <>
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" data-testid="api-definition-view" onClick={() => void onView()}>
              {viewing ? 'Hide document' : 'View document'}
            </Button>
            <Button variant="secondary" data-testid="api-definition-export" onClick={() => void onExport()}>
              Export…
            </Button>
          </div>
          {error !== undefined && (
            <p data-testid="api-definition-error" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          {viewing && documents !== undefined && (
            <div className="mt-2 flex flex-col gap-1">
              {documents.documents.length > 1 && (
                <select
                  aria-label="Definition document"
                  data-testid="api-definition-document"
                  value={selected ?? ''}
                  onChange={(event) => setSelected(event.target.value)}
                  className="h-row w-full rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
                >
                  {documents.documents.map((document) => (
                    <option key={document.location} value={document.location}>
                      {`${definitionDocumentLabel(document.location)} — ${formatBytes(document.size)}`}
                    </option>
                  ))}
                </select>
              )}
              <div className="h-80 overflow-hidden rounded border border-hairline-strong">
                {text === undefined ? (
                  <p className="p-2 text-sm text-fg-subtle">Loading…</p>
                ) : (
                  <Suspense fallback={<p className="p-2 text-sm text-fg-subtle">Loading editor…</p>}>
                    <CodeEditor
                      value={text}
                      language={definitionLanguage(selected ?? '')}
                      readOnly
                      ariaLabel="Definition document"
                    />
                  </Suspense>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="pt-1 text-sm text-fg-subtle">
          This definition was not cached, so there is nothing stored to view or export.
        </p>
      )}
    </div>
  );
}
