/**
 * The Import Postman Collection dialog.
 *
 * Provides File and Paste tabs for importing Postman Collection v2.0/v2.1 JSON documents,
 * target project selection, optional name and base URL overrides, and displays an import summary.
 */
import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type {
  PostmanImportSummaryWire,
  PostmanSourceWire,
  ProjectAddInterfaceTarget,
} from '../../../shared/wire-types.js';
import { Button } from '../../components/button.js';
import { Tabs } from '../../components/tabs.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { getExplorerTree } from './explorer-api.js';

type SourceTab = 'file' | 'paste';

const NEW_PROJECT = '';

const TABS = [
  { id: 'file', label: 'File' },
  { id: 'paste', label: 'Paste' },
] as const satisfies readonly { id: SourceTab; label: string }[];

export function nameFromSource(source: PostmanSourceWire | undefined): string {
  if (source === undefined) {
    return 'Imported Collection';
  }
  const raw = source.kind === 'file' ? source.path : '';
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
  return name.length > 0 ? name : 'Imported Collection';
}

function selectedProjectId(): string | undefined {
  const selection = useUiStore.getState().selection;
  const store = useProjectStore.getState();
  if (selection === undefined) {
    return undefined;
  }
  return store.projectOf[selection.requestId ?? selection.apiId ?? selection.interfaceId ?? selection.id];
}

export interface ImportPostmanDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ImportPostmanDialog({ open, onOpenChange }: ImportPostmanDialogProps) {
  const [tab, setTab] = useState<SourceTab>('file');
  const [filePath, setFilePath] = useState('');
  const [dropped, setDropped] = useState<{ name: string; text: string } | undefined>(undefined);
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [target, setTarget] = useState<string>(NEW_PROJECT);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ apiId: string; summary: PostmanImportSummaryWire } | undefined>(undefined);

  const order = useProjectStore((state) => state.order);
  const mirror = useProjectStore((state) => state.projects);
  const openProjects = order
    .map((group) => mirror[group.projectId])
    .filter((project): project is NonNullable<typeof project> => project !== undefined)
    .map((project) => ({ id: project.id, name: project.name }));

  useEffect(() => {
    if (!open) {
      return;
    }
    const store = useProjectStore.getState();
    const selected = selectedProjectId();
    const only = store.order.length === 1 ? store.order[0]?.projectId : undefined;
    setTarget(selected ?? only ?? NEW_PROJECT);
  }, [open]);

  const reset = useCallback((): void => {
    setImportError(undefined);
    setResult(undefined);
    setFilePath('');
    setDropped(undefined);
    setPasted('');
    setName('');
    setBaseUrl('');
  }, []);

  function buildSource(): PostmanSourceWire | undefined {
    if (tab === 'file') {
      if (dropped !== undefined) {
        return { kind: 'text', text: dropped.text };
      }
      return filePath.length > 0 ? { kind: 'file', path: filePath } : undefined;
    }
    return pasted.length > 0 ? { kind: 'text', text: pasted } : undefined;
  }

  async function browseForFile(): Promise<void> {
    const picked = await ipc().dialogs.openFile({
      title: 'Import Postman Collection',
      filters: [{ name: 'Postman Collection', extensions: ['json'] }],
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
      setFilePath(file.name);
      setDropped({ name: file.name, text });
    } catch {
      setImportError(`Could not read "${file.name}"`);
    }
  }

  const currentSource = buildSource();
  const sourceName = nameFromSource(currentSource);
  const newProjectName = name.trim().length > 0 ? name.trim() : sourceName;

  async function onImport(): Promise<void> {
    const source = buildSource();
    if (source === undefined) {
      setImportError(tab === 'file' ? 'Pick a .json file to import' : 'Paste a Postman collection JSON to import');
      return;
    }

    const importTarget: ProjectAddInterfaceTarget = target === NEW_PROJECT ? { newProjectName } : { projectId: target };

    setImporting(true);
    setImportError(undefined);

    try {
      const res = await ipc().api.importPostman({
        target: importTarget,
        source,
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
        ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
      });

      if (!res.ok) {
        setImportError(res.error.message);
        return;
      }

      getExplorerTree()?.open(`proj:${res.value.projectId}`);
      setResult({ apiId: res.value.apiId, summary: res.value.summary });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          data-testid="import-postman-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-hairline-strong bg-surface-base p-6 shadow-xl outline-none"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-fg-default">
              {result === undefined ? 'Import Postman Collection' : 'Imported Postman Collection'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-1 text-fg-subtle hover:text-fg-default" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {result === undefined
              ? 'Import a Postman collection (v2.0 or v2.1) JSON file or paste its contents.'
              : 'The collection was imported into your project.'}
          </Dialog.Description>

          {result === undefined ? (
            <>
              <div className="mt-4">
                <Tabs label="Postman source" items={TABS} active={tab} onSelect={(id) => setTab(id)} />
              </div>

              <div className="mt-3 flex flex-col gap-2">
                {tab === 'file' && (
                  <>
                    <div className="flex items-center gap-2">
                      <input
                        data-testid="import-postman-file-input"
                        aria-label="Postman collection file path"
                        value={filePath}
                        onChange={(event) => {
                          setDropped(undefined);
                          setFilePath(event.target.value);
                        }}
                        placeholder="Path to collection.json"
                        className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none"
                      />
                      <Button data-testid="import-postman-browse" onClick={() => void browseForFile()}>
                        Browse…
                      </Button>
                    </div>
                    <div
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => void onDrop(event)}
                      className="flex h-20 items-center justify-center rounded border border-dashed border-hairline-strong text-sm text-fg-subtle"
                    >
                      Drop a .json collection file here
                    </div>
                  </>
                )}

                {tab === 'paste' && (
                  <textarea
                    aria-label="Pasted Postman collection"
                    data-testid="import-postman-paste"
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                    placeholder='{"info": {"name": "My Collection", ...}}'
                    rows={8}
                    className="rounded border border-hairline-strong bg-surface-base p-2 font-mono text-xs text-fg-default outline-none"
                  />
                )}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <label className="w-28 shrink-0 text-sm text-fg-subtle" htmlFor="import-postman-name">
                  API name
                </label>
                <input
                  id="import-postman-name"
                  data-testid="import-postman-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="From collection name"
                  className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              <div className="mt-2 flex items-center gap-2">
                <label className="w-28 shrink-0 text-sm text-fg-subtle" htmlFor="import-postman-target-project">
                  Into project
                </label>
                <select
                  id="import-postman-target-project"
                  data-testid="import-postman-target-project"
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

              <div className="mt-2 flex items-center gap-2">
                <label className="w-28 shrink-0 text-sm text-fg-subtle" htmlFor="import-postman-base-url">
                  Base URL
                </label>
                <input
                  id="import-postman-base-url"
                  data-testid="import-postman-base-url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="Optional base URL override"
                  className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              {importError !== undefined && (
                <p role="alert" data-testid="import-postman-error" className="mt-3 text-sm text-status-danger">
                  {importError}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button disabled={importing}>Cancel</Button>
                </Dialog.Close>
                <Button
                  data-testid="import-postman-submit"
                  variant="primary"
                  disabled={importing}
                  onClick={() => void onImport()}
                >
                  {importing ? 'Importing…' : 'Import'}
                </Button>
              </div>
            </>
          ) : (
            <div data-testid="import-postman-summary" className="mt-3 flex flex-col gap-3">
              <div className="rounded border border-hairline-strong p-3 text-sm text-fg-default">
                <p className="font-semibold text-base">{result.summary.name}</p>
                {result.summary.description !== undefined && (
                  <p className="mt-1 text-xs text-fg-subtle">{result.summary.description}</p>
                )}
                <p data-testid="import-postman-counts" className="mt-2 text-sm text-fg-default">
                  {result.summary.requests} request{result.summary.requests === 1 ? '' : 's'} in{' '}
                  {result.summary.folders} folder{result.summary.folders === 1 ? '' : 's'}.
                </p>
                {result.summary.auth !== undefined && (
                  <p className="mt-1 text-xs text-fg-subtle">
                    Default authentication: <span className="font-medium text-fg-default">{result.summary.auth}</span>
                  </p>
                )}
              </div>

              <div className="flex justify-end">
                <Button
                  data-testid="import-postman-done"
                  variant="primary"
                  onClick={() => {
                    onOpenChange(false);
                    reset();
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
