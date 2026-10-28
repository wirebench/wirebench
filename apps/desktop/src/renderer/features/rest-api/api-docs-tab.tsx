/**
 * An API's complete documentation (API Overview spec §3.3), read-only: the API, a table of contents,
 * then every folder and request in the explorer's order with its description, URL, parameters, body
 * and examples. Built from the project mirror with the same builder the exported file uses, so the
 * tab and the file say the same thing. Nothing is resolved: `${…}` shows as written.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { buildApiDocument, type DocParam, type DocRequest, type DocsFolderInput } from '@wirebench/engine/rest';
import { authTypeLabel } from '../../components/auth-fields.js';
import { Button } from '../../components/button.js';
import { MarkdownView } from '../../components/markdown-view.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { RestApiWire, RestRequestWire } from '@shared/kinds/rest/wire.js';
import type { RestFolderWire } from '@shared/wire-base.js';
import { hasCapability } from '../../lib/capabilities.js';

/** How many lines of an example's body show before Show all. */
export const EXAMPLE_PREVIEW_LINES = 12;

export interface ApiDocsTabProps {
  readonly apiId: string;
}

/** The mirror's flat folders and requests as the nested shape the document builder reads. */
export function docsTree(
  apiId: string,
  folders: Readonly<Record<string, RestFolderWire>>,
  requests: Readonly<Record<string, RestRequestWire>>,
): { readonly folders: DocsFolderInput[]; readonly requests: RestRequestWire[] } {
  const ownFolders = Object.values(folders).filter((folder) => folder.apiId === apiId);
  const ownRequests = Object.values(requests).filter((request) => request.apiId === apiId);
  const folderOf = (parentId: string | undefined): DocsFolderInput[] =>
    ownFolders
      .filter((folder) => folder.parentId === parentId)
      .map((folder) => ({
        name: folder.name,
        order: folder.order,
        description: folder.description,
        folders: folderOf(folder.id),
        requests: ownRequests.filter((request) => request.folderId === folder.id),
      }));
  return { folders: folderOf(undefined), requests: ownRequests.filter((request) => request.folderId === undefined) };
}

const METHOD_CLASS: Readonly<Record<string, string>> = {
  GET: 'text-method-get',
  POST: 'text-method-post',
  PUT: 'text-method-put',
  PATCH: 'text-method-patch',
  DELETE: 'text-method-delete',
};

function Method({ method }: { readonly method: string }) {
  return (
    <span className={`font-mono text-xs font-semibold ${METHOD_CLASS[method] ?? 'text-method-other'}`}>{method}</span>
  );
}

function ParamTable({ title, rows }: { readonly title: string; readonly rows: readonly DocParam[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <h5 className="mb-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">{title}</h5>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-fg-subtle">
            <th className="border-b border-hairline py-1 pr-3 font-medium">Name</th>
            <th className="border-b border-hairline py-1 pr-3 font-medium">Value</th>
            <th className="border-b border-hairline py-1 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className="align-top">
              <td className="border-b border-hairline py-1 pr-3 font-mono text-xs">{row.name}</td>
              <td className="border-b border-hairline py-1 pr-3 font-mono text-xs break-all">{row.value}</td>
              <td className="border-b border-hairline py-1 text-fg-muted">{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Code({ children }: { readonly children: ReactNode }) {
  return (
    <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-hairline bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function Example({ example }: { readonly example: DocRequest['examples'][number] }) {
  const [all, setAll] = useState(false);
  const lines = example.body.split('\n');
  const long = lines.length > EXAMPLE_PREVIEW_LINES;
  return (
    <div data-testid="api-docs-example" className="mt-2">
      <p className="text-sm">
        <span className="italic">{example.name}</span>
        <span className="text-fg-subtle">
          {' — '}
          {example.status}
          {example.contentType === '' ? '' : ` · ${example.contentType}`}
        </span>
      </p>
      {example.body !== '' && (
        <>
          <Code>{all || !long ? example.body : lines.slice(0, EXAMPLE_PREVIEW_LINES).join('\n')}</Code>
          {long && (
            <button
              type="button"
              data-testid="api-docs-example-toggle"
              onClick={() => {
                setAll(!all);
              }}
              className="mt-1 text-xs text-accent hover:text-accent-hover hover:underline"
            >
              {all ? 'Show less' : `Show all ${String(lines.length)} lines`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function headingClass(depth: number): string {
  return depth === 0 ? 'text-lg' : depth === 1 ? 'text-md' : 'text-sm';
}

/** Main builds the file and runs the Save dialog; the tab only names the format and reports the outcome. */
async function exportDocs(apiId: string, format: 'html' | 'markdown'): Promise<void> {
  const result = await ipc().api.exportDocs({ apiId, format });
  if (!result.ok) {
    showToast(`The documentation could not be saved: ${result.error.message}`);
  } else if (!result.value.cancelled && result.value.path !== undefined) {
    showToast(`Documentation written to ${result.value.path}`);
  }
}

export function ApiDocsTab({ apiId }: ApiDocsTabProps) {
  const [exporting, setExporting] = useState(false);
  const api: RestApiWire | undefined = useProjectStore((state) => state.apis[apiId]);
  const folders = useProjectStore((state) => state.folders);
  const requests = useProjectStore((state) => state.restRequests);

  const doc = useMemo(() => {
    if (api === undefined) return undefined;
    const tree = docsTree(apiId, folders, requests);
    const auth = api.auth === undefined || api.auth.type === 'inherit' ? 'none' : api.auth.type;
    return buildApiDocument(
      { name: api.name, description: api.description, baseUrl: api.baseUrl, ...tree },
      authTypeLabel(auth),
    );
  }, [api, apiId, folders, requests]);

  if (doc === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This API is no longer in the project.</p>;
  }

  // Scrolls within the tab: a hash link would navigate the app's own window.
  const jump = (anchor: string): void => {
    document.getElementById(`api-docs-${anchor}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };

  return (
    <section aria-label={`${doc.name} documentation`} data-testid="api-docs-tab" className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-6 py-5">
        <header className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="min-w-0 text-2xl font-semibold break-words text-fg-default">{doc.name}</h2>
            <div className="flex shrink-0 gap-2">
              {/* Each writes to a file picked in a native dialog. */}
              {hasCapability('dialogs') &&
                (['html', 'markdown'] as const).map((format) => (
                  <Button
                    key={format}
                    data-testid={`api-docs-export-${format}`}
                    disabled={exporting}
                    onClick={() => {
                      setExporting(true);
                      void exportDocs(apiId, format).finally(() => {
                        setExporting(false);
                      });
                    }}
                  >
                    {format === 'html' ? 'Export HTML…' : 'Export Markdown…'}
                  </Button>
                ))}
            </div>
          </div>
          <ul className="mt-1 flex flex-wrap gap-x-4 text-xs text-fg-subtle">
            {doc.baseUrl !== '' && (
              <li>
                Base URL <span className="font-mono text-fg-muted">{doc.baseUrl}</span>
              </li>
            )}
            <li>Auth {doc.auth}</li>
          </ul>
        </header>
        {doc.description !== '' && <MarkdownView source={doc.description} className="mb-6" />}

        {doc.entries.length > 0 && (
          <nav aria-label="Contents" className="mb-6 rounded-md border border-hairline p-3">
            <h3 className="mb-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Contents</h3>
            <ul className="text-sm">
              {doc.entries.map((entry) => (
                <li key={entry.anchor} style={{ paddingLeft: `${String(entry.depth)}rem` }}>
                  <button
                    type="button"
                    data-testid="api-docs-toc"
                    onClick={() => {
                      jump(entry.anchor);
                    }}
                    className="inline-flex items-center gap-1.5 py-0.5 text-left text-accent hover:text-accent-hover hover:underline"
                  >
                    {entry.kind === 'request' && <Method method={entry.method} />}
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}

        {doc.entries.map((entry) =>
          entry.kind === 'folder' ? (
            <section
              key={entry.anchor}
              id={`api-docs-${entry.anchor}`}
              data-testid="api-docs-folder"
              className="mt-6 scroll-mt-4"
            >
              <h3 className={`font-semibold text-fg-default ${headingClass(entry.depth)}`}>{entry.name}</h3>
              {entry.description !== '' && <MarkdownView source={entry.description} className="mt-1" />}
            </section>
          ) : (
            <section
              key={entry.anchor}
              id={`api-docs-${entry.anchor}`}
              data-testid="api-docs-request"
              className="mt-5 scroll-mt-4 border-t border-hairline pt-4"
            >
              <h4 className="flex items-center gap-2 text-md font-semibold text-fg-default">
                <Method method={entry.method} />
                {entry.name}
              </h4>
              <p className="mt-1 font-mono text-xs break-all text-fg-muted">{entry.url}</p>
              {entry.description !== '' && <MarkdownView source={entry.description} className="mt-2" />}
              <ParamTable title="Path parameters" rows={entry.pathParams} />
              <ParamTable title="Query parameters" rows={entry.query} />
              <ParamTable title="Headers" rows={entry.headers} />
              {entry.body !== undefined && (
                <div className="mt-3">
                  <h5 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">
                    Body <span className="tracking-normal normal-case">({entry.body.label})</span>
                  </h5>
                  <Code>{entry.body.text}</Code>
                </div>
              )}
              {entry.examples.length > 0 && (
                <div className="mt-3">
                  <h5 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">Examples</h5>
                  {entry.examples.map((example) => (
                    <Example key={`${example.name}-${example.status}`} example={example} />
                  ))}
                </div>
              )}
            </section>
          ),
        )}
      </div>
    </section>
  );
}
