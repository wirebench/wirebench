/**
 * The Import OpenAPI dialog.
 *
 * Two screens in one, because an import has two moments the user cares about: *before*, when the
 * question is where to read from and what the API should be called, and *after*, when the question
 * is what was actually made and what the document said that this client could not use. The summary
 * is not a toast — an import creates dozens of requests and skips some of them, and that is worth a
 * panel the user closes when they have read it.
 *
 * The security-scheme choice lives on the summary screen rather than before the import, and that is
 * deliberate: which schemes a document declares is only known once it has been read, and reading it
 * twice to ask would double every fetch. The import applies the document's own default (a single
 * global requirement), lists every scheme it found, and lets the user switch to another with one
 * click — the engine computed what each one becomes, so switching is an ordinary API edit.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type {
  EngineProgressEvent,
  OpenApiImportSummaryWire,
  OpenApiSourceWire,
  ProjectAddInterfaceTarget,
} from '../../../shared/wire-types.js';
import { Button } from '../../components/button.js';
import { Tabs } from '../../components/tabs.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { getExplorerTree } from './explorer-api.js';

type SourceTab = 'url' | 'file' | 'paste';

/** The `import-openapi-target-project` value standing for *New project "<name>"*. Never a project id. */
const NEW_PROJECT = '';

const TABS = [
  { id: 'url', label: 'URL' },
  { id: 'file', label: 'File' },
  { id: 'paste', label: 'Paste' },
] as const satisfies readonly { id: SourceTab; label: string }[];

/**
 * A name derived from what is being imported, for the *New project* option and as the placeholder
 * the API name field shows: `…/petstore.yaml` becomes `petstore`, a URL whose path says nothing
 * falls back to its host, and pasted text — which names nothing — becomes "Imported API".
 *
 * Only a placeholder: the API's real name comes from `info.title` unless the user types one, which
 * is why the field is left empty rather than pre-filled with a guess from the URL.
 */
export function nameFromSource(source: OpenApiSourceWire | undefined): string {
  if (source === undefined) {
    return 'Imported API';
  }
  let host = '';
  const raw =
    source.kind === 'url'
      ? (() => {
          try {
            const url = new URL(source.url);
            host = url.hostname;
            return url.pathname;
          } catch {
            return source.url;
          }
        })()
      : source.kind === 'file'
        ? source.path
        : (source.location ?? '');
  const segment =
    raw
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .at(-1) ?? '';
  const name = segment
    .replace(/\?.*$/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/^dropped:/, '')
    .trim();
  if (name.length > 0) {
    return name;
  }
  return host.length > 0 ? host : 'Imported API';
}

/** The project selected in the explorer, by whichever entity the selection names. */
function selectedProjectId(): string | undefined {
  const selection = useUiStore.getState().selection;
  const store = useProjectStore.getState();
  if (selection === undefined) {
    return undefined;
  }
  return store.projectOf[selection.requestId ?? selection.apiId ?? selection.interfaceId ?? selection.id];
}

export interface ImportOpenApiDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The Import OpenAPI dialog: pick a source, then read what the import made of it. */
export function ImportOpenApiDialog({ open, onOpenChange }: ImportOpenApiDialogProps) {
  const [tab, setTab] = useState<SourceTab>('url');
  const [url, setUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  // A dropped file, read in the renderer: a drag is not a dialog pick, so main will not read a
  // dropped path (see `main/path-access.ts`) and the bytes travel as `text` instead. The trade is
  // that the document's own relative `$ref`s cannot resolve — `inline:` is not a folder.
  const [dropped, setDropped] = useState<{ name: string; text: string } | undefined>(undefined);
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [cache, setCache] = useState(true);
  const [target, setTarget] = useState<string>(NEW_PROJECT);
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ apiId: string; summary: OpenApiImportSummaryWire } | undefined>(undefined);
  const tokenRef = useRef<string | undefined>(undefined);
  // Tokens for imports the user cancelled: the in-flight promise still settles after `onCancel`
  // returns, so its rejection must be ignored rather than shown as a failure.
  const cancelledTokensRef = useRef<Set<string>>(new Set());

  const order = useProjectStore((state) => state.order);
  const mirror = useProjectStore((state) => state.projects);
  const openProjects = order
    .map((group) => mirror[group.projectId])
    .filter((project): project is NonNullable<typeof project> => project !== undefined)
    .map((project) => ({ id: project.id, name: project.name }));

  // Each opening picks its own default target: the project the explorer has selected, else the only
  // project there is, else a new one. Read at open time so it follows the selection without
  // re-running as the project list changes, which would overwrite a choice already made.
  useEffect(() => {
    if (!open) {
      return;
    }
    const store = useProjectStore.getState();
    const selected = selectedProjectId();
    const only = store.order.length === 1 ? store.order[0]?.projectId : undefined;
    setTarget(selected ?? only ?? NEW_PROJECT);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    return window.wirebench.on('engine.progress', ((event: EngineProgressEvent) => {
      if (event.kind !== 'import' || event.token === undefined || event.token !== tokenRef.current) {
        return;
      }
      setProgress(event.message);
    }) as (payload: unknown) => void);
  }, [open]);

  const reset = useCallback((): void => {
    setImportError(undefined);
    setProgress(undefined);
    setResult(undefined);
  }, []);

  function buildSource(): OpenApiSourceWire | undefined {
    if (tab === 'url') {
      try {
        void new URL(url);
      } catch {
        setUrlError('Enter a valid URL');
        return undefined;
      }
      setUrlError(undefined);
      return { kind: 'url', url };
    }
    if (tab === 'file') {
      if (dropped !== undefined) {
        return { kind: 'text', text: dropped.text, location: `dropped:${dropped.name}` };
      }
      return filePath.length > 0 ? { kind: 'file', path: filePath } : undefined;
    }
    return pasted.length > 0 ? { kind: 'text', text: pasted } : undefined;
  }

  async function browseForFile(): Promise<void> {
    const picked = await ipc().dialogs.openFile({
      title: 'Import OpenAPI',
      filters: [{ name: 'OpenAPI', extensions: ['yaml', 'yml', 'json'] }],
    });
    if (picked.ok && picked.value.path !== undefined) {
      setDropped(undefined);
      setFilePath(picked.value.path);
    }
  }

  async function onDrop(event: React.DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file === undefined) {
      return;
    }
    setImportError(undefined);
    try {
      const text = await file.text();
      setDropped({ name: file.name, text });
      setFilePath(file.name);
    } catch {
      setImportError(`Could not read "${file.name}"`);
    }
  }

  async function onImport(): Promise<void> {
    if (importing) {
      // Guards a double submit racing two imports under one token.
      return;
    }
    reset();
    const source = buildSource();
    if (source === undefined) {
      return;
    }
    const token = crypto.randomUUID();
    tokenRef.current = token;
    setImporting(true);
    try {
      // A project that left the workspace while the dialog sat open falls back to a new one.
      const chosen = openProjects.some((project) => project.id === target) ? target : NEW_PROJECT;
      const into: ProjectAddInterfaceTarget =
        chosen === NEW_PROJECT ? { newProjectName: nameFromSource(source) } : { projectId: chosen };
      const imported = await useProjectStore.getState().importOpenApi({
        target: into,
        source,
        cache,
        token,
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      });
      if (cancelledTokensRef.current.has(token)) {
        return;
      }
      // The new API arrives folded shut; unfold its project so it is at least visible.
      getExplorerTree()?.open(`proj:${imported.projectId}`);
      setResult({ apiId: imported.apiId, summary: imported.summary });
    } catch (error) {
      if (cancelledTokensRef.current.has(token)) {
        return;
      }
      setImportError(error instanceof Error ? error.message : 'Import failed');
    } finally {
      cancelledTokensRef.current.delete(token);
      if (tokenRef.current === token) {
        tokenRef.current = undefined;
      }
      setImporting(false);
      setProgress(undefined);
    }
  }

  async function onCancel(): Promise<void> {
    const token = tokenRef.current;
    if (token !== undefined) {
      cancelledTokensRef.current.add(token);
      await ipc().api.cancelImport({ token });
    }
    setImporting(false);
    setProgress(undefined);
  }

  // The *New project* option's name, from whatever is typed so far. Derived on render rather than
  // from `buildSource`, which reports validation errors, so it tracks the field as the user types.
  const newProjectName = nameFromSource(
    tab === 'url'
      ? url.length > 0
        ? { kind: 'url', url }
        : undefined
      : tab === 'file'
        ? dropped !== undefined
          ? { kind: 'text', text: '', location: `dropped:${dropped.name}` }
          : filePath.length > 0
            ? { kind: 'file', path: filePath }
            : undefined
        : undefined,
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setDropped(undefined);
          reset();
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="import-openapi-dialog"
          className="fixed top-1/2 left-1/2 max-h-[85vh] w-[34rem] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">Import OpenAPI</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {result === undefined ? (
            <>
              <div className="mt-3">
                <Tabs label="Import source" items={TABS} active={tab} onSelect={setTab} />
              </div>

              <div className="mt-3 flex flex-col gap-2">
                {tab === 'url' && (
                  <>
                    <label className="text-sm text-fg-subtle" htmlFor="import-openapi-url">
                      OpenAPI document URL
                    </label>
                    <input
                      id="import-openapi-url"
                      data-testid="import-openapi-url"
                      autoFocus
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !importing) {
                          event.preventDefault();
                          void onImport();
                        }
                      }}
                      placeholder="https://api.example.com/openapi.yaml"
                      className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                    />
                    {urlError !== undefined && <p className="text-sm text-status-danger">{urlError}</p>}
                  </>
                )}

                {tab === 'file' && (
                  <>
                    <div className="flex gap-2">
                      <input
                        aria-label="File path"
                        data-testid="import-openapi-path"
                        value={filePath}
                        onChange={(event) => {
                          setDropped(undefined);
                          setFilePath(event.target.value);
                        }}
                        placeholder="/path/to/openapi.yaml"
                        className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm outline-none"
                      />
                      <Button data-testid="import-openapi-browse" onClick={() => void browseForFile()}>
                        Browse…
                      </Button>
                    </div>
                    <div
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => void onDrop(event)}
                      className="flex h-20 items-center justify-center rounded border border-dashed border-hairline-strong text-sm text-fg-subtle"
                    >
                      Drop a .yaml, .yml or .json file here
                    </div>
                  </>
                )}

                {tab === 'paste' && (
                  <textarea
                    aria-label="Pasted OpenAPI document"
                    data-testid="import-openapi-paste"
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                    rows={8}
                    className="rounded border border-hairline-strong bg-surface-base p-2 font-mono text-xs text-fg-default outline-none"
                  />
                )}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <label className="w-28 shrink-0 text-sm text-fg-subtle" htmlFor="import-openapi-name">
                  API name
                </label>
                <input
                  id="import-openapi-name"
                  data-testid="import-openapi-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="From the document’s title"
                  className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              <div className="mt-2 flex items-center gap-2">
                <label className="w-28 shrink-0 text-sm text-fg-subtle" htmlFor="import-openapi-target-project">
                  Into project
                </label>
                <select
                  id="import-openapi-target-project"
                  data-testid="import-openapi-target-project"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                >
                  {openProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                  <option value={NEW_PROJECT}>{`New project “${newProjectName}”`}</option>
                </select>
              </div>

              <label className="mt-2 flex items-center gap-2 text-sm text-fg-subtle">
                <input
                  type="checkbox"
                  data-testid="import-openapi-cache"
                  checked={cache}
                  onChange={(event) => setCache(event.target.checked)}
                />
                Cache the definition, so it can be viewed and exported offline
              </label>

              {progress !== undefined && (
                <p data-testid="import-openapi-progress" className="mt-3 truncate text-sm text-fg-subtle">
                  {progress}
                </p>
              )}
              {importError !== undefined && (
                <p data-testid="import-openapi-error" className="mt-3 text-sm text-status-danger">
                  {importError}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                {importing ? (
                  <Button data-testid="import-openapi-cancel" onClick={() => void onCancel()}>
                    Cancel
                  </Button>
                ) : (
                  <>
                    <Dialog.Close asChild>
                      <Button>Cancel</Button>
                    </Dialog.Close>
                    <Button data-testid="import-openapi-submit" variant="primary" onClick={() => void onImport()}>
                      Import
                    </Button>
                  </>
                )}
              </div>
            </>
          ) : (
            <ImportSummary
              apiId={result.apiId}
              summary={result.summary}
              onDone={() => {
                onOpenChange(false);
                reset();
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What the import made, and what it could not use. */
function ImportSummary({
  apiId,
  summary,
  onDone,
}: {
  readonly apiId: string;
  readonly summary: OpenApiImportSummaryWire;
  readonly onDone: () => void;
}) {
  const updateApi = useProjectStore((state) => state.updateApi);
  // Which scheme is in force, tracked here so the row reflects a switch at once: the API itself is
  // updated through the ordinary edit path, and the mirror follows.
  const [applied, setApplied] = useState<string | undefined>(
    summary.securitySchemes.find((scheme) => scheme.applied)?.name,
  );
  const usable = summary.securitySchemes.filter((scheme) => scheme.auth !== undefined);

  return (
    <div data-testid="import-openapi-summary" className="mt-3 flex flex-col gap-3">
      <div className="rounded border border-hairline-strong p-2 text-sm text-fg-default">
        <p className="font-medium">{summary.name}</p>
        <p className="text-xs text-fg-subtle">
          OpenAPI {summary.declaredVersion}
          {summary.apiVersion !== undefined ? ` · API version ${summary.apiVersion}` : ''} · {summary.baseUrl}
        </p>
        <p data-testid="import-openapi-counts" className="mt-1 text-sm">
          {summary.requests} request{summary.requests === 1 ? '' : 's'} in {summary.folders} folder
          {summary.folders === 1 ? '' : 's'}
          {summary.deprecated > 0 ? `, ${summary.deprecated} deprecated` : ''}.
        </p>
      </div>

      {summary.securitySchemes.length > 0 && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="text-sm text-fg-default">Authentication</p>
          <p className="text-xs text-fg-subtle">
            {applied === undefined
              ? 'The document does not say which scheme this API uses. Pick one, or set it up later on the API tab.'
              : `Using “${applied}”. Credentials are yours to fill in on the API tab.`}
          </p>
          <ul data-testid="import-openapi-schemes" className="mt-1 flex flex-col gap-1">
            {summary.securitySchemes.map((scheme) => (
              <li key={scheme.name} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-fg-default">
                  {scheme.name} <span className="text-fg-subtle">({scheme.type})</span>
                  {scheme.reason !== undefined && <span className="text-fg-subtle"> — {scheme.reason}</span>}
                </span>
                {scheme.auth !== undefined &&
                  (scheme.name === applied ? (
                    <span className="text-fg-subtle">in use</span>
                  ) : (
                    <button
                      type="button"
                      data-testid={`import-openapi-use-${scheme.name}`}
                      className="text-accent underline"
                      onClick={() => {
                        setApplied(scheme.name);
                        void updateApi(apiId, { auth: scheme.auth ?? null });
                      }}
                    >
                      Use
                    </button>
                  ))}
              </li>
            ))}
          </ul>
          {usable.length === 0 && (
            <p className="mt-1 text-xs text-fg-subtle">None of them is a scheme this client can send.</p>
          )}
        </div>
      )}

      {summary.skipped.length > 0 && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="text-sm text-fg-default">
            {summary.skipped.length} thing{summary.skipped.length === 1 ? '' : 's'} not imported
          </p>
          <ul
            data-testid="import-openapi-skipped"
            className="mt-1 flex max-h-40 flex-col gap-1 overflow-auto text-xs text-fg-subtle"
          >
            {summary.skipped.map((entry, index) => (
              <li key={index}>
                <span className="text-fg-default">{entry.where}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <Button data-testid="import-openapi-done" variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
