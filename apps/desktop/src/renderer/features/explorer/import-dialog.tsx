/**
 * The Unified Import Dialog.
 *
 * Supports importing API definitions from:
 * - OpenAPI 3.0, 3.1, 3.2 and Swagger 1.x / 2.0 / 3.x (YAML / JSON)
 * - Postman Collections (v2.0, v2.1 JSON)
 * - WSDL 1.1 / 2.0 (SOAP XML)
 * - Protocol Buffers `.proto` files (gRPC)
 *
 * Provides URL, File (with drag-and-drop), and Paste input sources,
 * automatic format detection with manual override, target project selection,
 * progress tracking, and a unified summary screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Sparkles } from 'lucide-react';
import { detectImportFormat, type DetectedImportFormat, type ImportFormatKind } from '@wirebench/engine/detect';
import type {
  EngineProgressEvent,
  ImportProblemWire,
  ImportSourceWire,
  OpenApiImportSummaryWire,
  OpenApiSourceWire,
  PostmanImportSummaryWire,
  PostmanSourceWire,
  ProjectAddInterfaceTarget,
  ProtoImportSummaryWire,
  ProtoSourceWire,
} from '../../../shared/wire-types.js';
import { Button } from '../../components/button.js';
import { SecretField } from '../../components/secret-field.js';
import { Tabs } from '../../components/tabs.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore, type ImportDialogFormat } from '../../state/ui.js';
import { getExplorerTree } from './explorer-api.js';

export type SourceTab = 'url' | 'file' | 'paste';

/** The `import-target-project` value standing for *New project "<name>"*. Never a project id. */
export const NEW_PROJECT = '';

const TABS = [
  { id: 'url', label: 'URL' },
  { id: 'file', label: 'File' },
  { id: 'paste', label: 'Paste' },
] as const satisfies readonly { id: SourceTab; label: string }[];

/**
 * Derives a project/API name from the given source or file path.
 */
export function nameFromSource(
  source: { kind: string; [key: string]: unknown } | undefined,
  defaultName = 'Imported API',
): string {
  if (source === undefined) {
    return defaultName;
  }
  let host = '';
  const raw =
    source.kind === 'url' && typeof source['url'] === 'string'
      ? (() => {
          try {
            const parsedUrl = new URL(source['url']);
            host = parsedUrl.hostname;
            return parsedUrl.pathname;
          } catch {
            return source['url'];
          }
        })()
      : source.kind === 'file' && typeof source['path'] === 'string'
        ? source['path']
        : typeof source['location'] === 'string'
          ? source['location']
          : '';
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
  return host.length > 0 ? host : defaultName;
}

function selectedProjectId(): string | undefined {
  const selection = useUiStore.getState().selection;
  const store = useProjectStore.getState();
  if (selection === undefined) {
    return undefined;
  }
  return store.projectOf[selection.requestId ?? selection.apiId ?? selection.interfaceId ?? selection.id];
}

export type UnifiedImportResult =
  | {
      readonly kind: 'wsdl';
      readonly interfaceId: string;
      readonly name: string;
      readonly problems: ImportProblemWire[];
    }
  | { readonly kind: 'openapi'; readonly apiId: string; readonly summary: OpenApiImportSummaryWire }
  | { readonly kind: 'postman'; readonly apiId: string; readonly summary: PostmanImportSummaryWire }
  | { readonly kind: 'proto'; readonly apiId: string; readonly summary: ProtoImportSummaryWire };

export interface ImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialFormat?: ImportDialogFormat;
}

export function ImportDialog({ open, onOpenChange, initialFormat: propFormat }: ImportDialogProps) {
  const storeFormat = useUiStore((state) => state.importDialogFormat);
  const initialFmt = propFormat ?? storeFormat ?? 'auto';
  const [tab, setTab] = useState<SourceTab>(initialFmt === 'postman' ? 'file' : 'url');
  const [format, setFormat] = useState<ImportDialogFormat>(initialFmt);
  const [url, setUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  const [dropped, setDropped] = useState<{ name: string; text: string } | undefined>(undefined);
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [cache, setCache] = useState(true);
  // gRPC: whether the target speaks TLS. A `host:port` says nothing about it, unlike a URL.
  const [tls, setTls] = useState(false);

  // WSDL Basic Auth fields
  const [useAuth, setUseAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [passwordRef, setPasswordRef] = useState<string | undefined>(undefined);
  const passwordFlushRef = useRef<(() => Promise<string | undefined>) | undefined>(undefined);
  const registerPasswordFlush = useCallback((flush: (() => Promise<string | undefined>) | undefined) => {
    passwordFlushRef.current = flush;
  }, []);
  const [useForRequests, setUseForRequests] = useState(false);

  // Status and Target
  const [target, setTarget] = useState<string>(NEW_PROJECT);
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<UnifiedImportResult | undefined>(undefined);

  const tokenRef = useRef<string | undefined>(undefined);
  const cancelledTokensRef = useRef<Set<string>>(new Set());

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
    const fmt = propFormat ?? useUiStore.getState().importDialogFormat ?? 'auto';
    setFormat(fmt);
    if (fmt === 'postman') {
      setTab('file');
    }
  }, [open, propFormat]);

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

  // Real-time format detection
  const detected: DetectedImportFormat = useMemo(() => {
    const currentText = tab === 'paste' ? pasted : tab === 'file' ? dropped?.text : undefined;
    const currentFilename =
      tab === 'file' ? (dropped?.name ?? (filePath.length > 0 ? filePath : undefined)) : undefined;
    const currentUrl = tab === 'url' && url.length > 0 ? url : undefined;
    return detectImportFormat({ text: currentText, filename: currentFilename, url: currentUrl });
  }, [tab, pasted, dropped, filePath, url]);

  const effectiveFormat: ImportFormatKind = format !== 'auto' ? format : detected.kind;

  const reset = useCallback((): void => {
    setImportError(undefined);
    setProgress(undefined);
    setResult(undefined);
    setUrlError(undefined);
    setDropped(undefined);
    setFilePath('');
    setPasted('');
    setUrl('');
    setName('');
    setBaseUrl('');
    setTls(false);
  }, []);

  function buildSource(): ImportSourceWire | undefined {
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
    const filters =
      effectiveFormat === 'postman'
        ? [{ name: 'Postman Collection', extensions: ['json'] }]
        : effectiveFormat === 'proto'
          ? [
              { name: 'Protocol Buffers', extensions: ['proto'] },
              { name: 'All Files', extensions: ['*'] },
            ]
          : effectiveFormat === 'openapi'
            ? [
                { name: 'OpenAPI Specification', extensions: ['json', 'yaml', 'yml'] },
                { name: 'All Files', extensions: ['*'] },
              ]
            : [
                {
                  name: 'API Definitions (*.json, *.yaml, *.yml, *.wsdl, *.xml)',
                  extensions: ['json', 'yaml', 'yml', 'wsdl', 'xml'],
                },
                { name: 'All Files', extensions: ['*'] },
              ];
    const title =
      effectiveFormat === 'postman'
        ? 'Import Postman Collection'
        : effectiveFormat === 'proto'
          ? 'Import .proto'
          : effectiveFormat === 'openapi'
            ? 'Import OpenAPI Specification'
            : 'Import Definition';
    const res = await ipc().dialogs.openFile({ title, filters });
    if (res.ok && res.value.path !== undefined) {
      setDropped(undefined);
      setFilePath(res.value.path);
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

  const previewSource =
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
        : undefined;

  const defaultName =
    format === 'wsdl' || (format === 'auto' && (effectiveFormat === 'wsdl' || effectiveFormat === 'unknown'))
      ? 'Imported service'
      : format === 'postman' || effectiveFormat === 'postman'
        ? 'Imported Collection'
        : format === 'proto' || effectiveFormat === 'proto'
          ? 'Imported gRPC API'
          : 'Imported API';

  const sourceName = nameFromSource(previewSource, defaultName);
  const newProjectName = name.trim().length > 0 ? name.trim() : sourceName;

  async function onImport(): Promise<void> {
    if (importing) {
      return;
    }
    setImportError(undefined);
    const source = buildSource();
    if (source === undefined) {
      if (tab === 'url') {
        setUrlError('Enter a valid URL');
      } else if (tab === 'file') {
        setImportError(effectiveFormat === 'postman' ? 'Pick a .json file to import' : 'Pick a file to import');
      } else {
        setImportError(
          effectiveFormat === 'postman' ? 'Paste a .json collection to import' : 'Paste a definition to import',
        );
      }
      return;
    }

    // Determine target format
    let targetFormat: 'wsdl' | 'openapi' | 'postman' | 'proto';
    if (effectiveFormat === 'wsdl') {
      targetFormat = 'wsdl';
    } else if (effectiveFormat === 'proto') {
      targetFormat = 'proto';
    } else if (effectiveFormat === 'postman') {
      targetFormat = 'postman';
    } else if (effectiveFormat === 'openapi') {
      targetFormat = 'openapi';
    } else {
      // Unknown format: check hints
      if (tab === 'url' && (url.includes('?wsdl') || url.endsWith('.wsdl'))) {
        targetFormat = 'wsdl';
      } else if (tab === 'paste' && pasted.trim().startsWith('<')) {
        targetFormat = 'wsdl';
      } else {
        targetFormat = 'wsdl';
      }
    }

    const token = crypto.randomUUID();
    tokenRef.current = token;
    setImporting(true);

    const chosen = openProjects.some((project) => project.id === target) ? target : NEW_PROJECT;
    const into: ProjectAddInterfaceTarget = chosen === NEW_PROJECT ? { newProjectName } : { projectId: chosen };

    try {
      if (targetFormat === 'wsdl') {
        const flushedRef = (await passwordFlushRef.current?.()) ?? passwordRef;
        const options =
          useAuth && username.length > 0 && flushedRef !== undefined
            ? { auth: { username, passwordRef: flushedRef }, useForRequests }
            : undefined;

        const summary = await useProjectStore.getState().importDefinition(into, source, options, token);
        if (cancelledTokensRef.current.has(token)) {
          return;
        }
        if (chosen !== NEW_PROJECT) {
          getExplorerTree()?.open(`proj:${chosen}`);
        }
        useProblemsStore.getState().set(summary.id, summary.problems);
        if (summary.problems.length === 0) {
          onOpenChange(false);
          reset();
        } else {
          setResult({
            kind: 'wsdl',
            interfaceId: summary.id,
            name: summary.name,
            problems: summary.problems,
          });
        }
      } else if (targetFormat === 'openapi') {
        const openApiSource: OpenApiSourceWire =
          source.kind === 'url'
            ? { kind: 'url', url: source.url }
            : source.kind === 'file'
              ? { kind: 'file', path: source.path }
              : {
                  kind: 'text',
                  text: source.text,
                  ...(source.location !== undefined ? { location: source.location } : {}),
                };

        const imported = await useProjectStore.getState().importOpenApi({
          target: into,
          source: openApiSource,
          cache,
          token,
          ...(name.trim().length > 0 ? { name: name.trim() } : {}),
          ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
        });

        if (cancelledTokensRef.current.has(token)) {
          return;
        }
        getExplorerTree()?.open(`proj:${imported.projectId}`);
        setResult({
          kind: 'openapi',
          apiId: imported.apiId,
          summary: imported.summary,
        });
      } else if (targetFormat === 'proto') {
        // A picked file's imports are read from beside it in main; a pasted or dropped file keeps
        // its name, which is the import path other files would reach it by.
        const protoSource: ProtoSourceWire =
          source.kind === 'url'
            ? { kind: 'url', url: source.url }
            : source.kind === 'file'
              ? { kind: 'files', paths: [source.path] }
              : {
                  kind: 'text',
                  text: source.text,
                  ...(dropped !== undefined ? { filename: dropped.name } : {}),
                };

        const imported = await useProjectStore.getState().importProto({
          target: into,
          source: protoSource,
          cache,
          tls,
          token,
          ...(name.trim().length > 0 ? { name: name.trim() } : {}),
          ...(baseUrl.trim().length > 0 ? { grpcTarget: baseUrl.trim() } : {}),
        });

        if (cancelledTokensRef.current.has(token)) {
          return;
        }
        getExplorerTree()?.open(`proj:${imported.projectId}`);
        setResult({ kind: 'proto', apiId: imported.apiId, summary: imported.summary });
      } else {
        // Postman import
        if (source.kind === 'url') {
          setImportError(
            'Postman import via URL is not supported yet. Please download the collection file or paste its JSON.',
          );
          return;
        }

        const postmanSource: PostmanSourceWire =
          source.kind === 'file' ? { kind: 'file', path: source.path } : { kind: 'text', text: source.text };

        const res = await ipc().api.importPostman({
          target: into,
          source: postmanSource,
          ...(name.trim().length > 0 ? { name: name.trim() } : {}),
          ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
        });

        if (!res.ok) {
          setImportError(res.error.message);
          return;
        }

        getExplorerTree()?.open(`proj:${res.value.projectId}`);
        setResult({
          kind: 'postman',
          apiId: res.value.apiId,
          summary: res.value.summary,
        });
      }
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
      await Promise.all([
        ipc()
          .definition.cancelImport({ token })
          .catch(() => undefined),
        ipc()
          .api.cancelImport({ token })
          .catch(() => undefined),
      ]);
    }
    setImporting(false);
    setProgress(undefined);
  }

  const isRest = effectiveFormat === 'openapi' || effectiveFormat === 'postman';
  const isProto = effectiveFormat === 'proto';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid={
            format === 'postman'
              ? 'import-postman-dialog'
              : format === 'openapi'
                ? 'import-openapi-dialog'
                : format === 'proto'
                  ? 'import-proto-dialog'
                  : 'import-dialog'
          }
          className="fixed top-1/2 left-1/2 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">
              {result !== undefined
                ? 'Import Complete'
                : format === 'postman'
                  ? 'Import Postman Collection'
                  : format === 'openapi'
                    ? 'Import OpenAPI'
                    : format === 'wsdl'
                      ? 'Import WSDL'
                      : format === 'proto'
                        ? 'Import .proto'
                        : 'Import API or Service'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {result === undefined ? (
            <>
              {/* Format selection header */}
              <div className="mt-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-fg-subtle" htmlFor="import-format-select">
                    Format:
                  </label>
                  <select
                    id="import-format-select"
                    data-testid="import-format-select"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as ImportDialogFormat)}
                    className="rounded border border-hairline-strong bg-surface-base px-2 py-1 text-xs text-fg-default outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="openapi">OpenAPI / Swagger</option>
                    <option value="postman">Postman Collection</option>
                    <option value="wsdl">WSDL (SOAP)</option>
                    <option value="proto">Protocol Buffers (gRPC)</option>
                  </select>
                </div>

                {format === 'auto' && detected.kind !== 'unknown' && (
                  <span
                    data-testid="detected-format-badge"
                    className="flex items-center gap-1 rounded bg-accent-muted px-2 py-0.5 text-xs font-medium text-accent"
                  >
                    <Sparkles size={11} aria-hidden="true" />
                    {detected.label}
                  </span>
                )}
              </div>

              {/* Source tabs */}
              <div className="mt-3">
                <Tabs label="Import source" items={TABS} active={tab} onSelect={setTab} />
              </div>

              <div className="mt-3 flex flex-col gap-2">
                {tab === 'url' && (
                  <>
                    <label className="text-sm text-fg-subtle" htmlFor="import-url">
                      {effectiveFormat === 'openapi' || effectiveFormat === 'postman'
                        ? 'Specification URL'
                        : effectiveFormat === 'proto'
                          ? '.proto URL'
                          : 'WSDL URL'}
                    </label>
                    <input
                      id="import-url"
                      data-testid={format === 'openapi' ? 'import-openapi-url' : 'import-url-input'}
                      aria-label="WSDL URL"
                      autoFocus
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !importing) {
                          e.preventDefault();
                          void onImport();
                        }
                      }}
                      placeholder={
                        effectiveFormat === 'wsdl'
                          ? 'http://example.test/service.wsdl'
                          : effectiveFormat === 'proto'
                            ? 'https://example.test/protos/service.proto'
                            : 'https://example.test/openapi.json or ?wsdl'
                      }
                      className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                    />
                    {urlError !== undefined && <p className="text-sm text-status-danger">{urlError}</p>}

                    {(effectiveFormat === 'wsdl' || effectiveFormat === 'unknown') && (
                      <>
                        <label className="mt-1 flex items-center gap-2 text-sm text-fg-subtle">
                          <input type="checkbox" checked={useAuth} onChange={(e) => setUseAuth(e.target.checked)} />
                          Use Basic auth
                        </label>
                        {useAuth && (
                          <>
                            <div className="flex gap-2">
                              <input
                                aria-label="Username"
                                placeholder="Username"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm outline-none"
                              />
                            </div>
                            <SecretField
                              value={passwordRef}
                              onChange={setPasswordRef}
                              label="Password"
                              registerFlush={registerPasswordFlush}
                            />
                            <label className="flex items-center gap-2 text-sm text-fg-subtle">
                              <input
                                type="checkbox"
                                checked={useForRequests}
                                onChange={(e) => setUseForRequests(e.target.checked)}
                              />
                              Use these credentials for requests too
                            </label>
                          </>
                        )}
                      </>
                    )}
                  </>
                )}

                {tab === 'file' && (
                  <>
                    <div className="flex gap-2">
                      <input
                        aria-label={format === 'postman' ? 'Postman collection file path' : 'File path'}
                        data-testid={
                          format === 'postman'
                            ? 'import-postman-file-input'
                            : format === 'openapi'
                              ? 'import-openapi-path'
                              : 'import-file-input'
                        }
                        value={filePath}
                        onChange={(e) => {
                          setDropped(undefined);
                          setFilePath(e.target.value);
                        }}
                        placeholder={
                          format === 'postman'
                            ? 'Path to collection.json'
                            : format === 'proto'
                              ? '/path/to/service.proto'
                              : '/path/to/spec.json, .yaml, .wsdl, or .proto'
                        }
                        className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm outline-none"
                      />
                      <Button
                        data-testid={
                          format === 'postman'
                            ? 'import-postman-browse'
                            : format === 'openapi'
                              ? 'import-openapi-browse'
                              : 'import-browse'
                        }
                        onClick={() => void browseForFile()}
                      >
                        Browse…
                      </Button>
                    </div>
                    <div
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => void onDrop(e)}
                      className="flex h-20 items-center justify-center rounded border border-dashed border-hairline-strong text-sm text-fg-subtle"
                    >
                      {dropped !== undefined
                        ? `Loaded: ${dropped.name}`
                        : 'Drop an OpenAPI, Postman, WSDL or .proto file here'}
                    </div>
                  </>
                )}

                {tab === 'paste' && (
                  <textarea
                    aria-label={format === 'postman' ? 'Pasted Postman collection' : 'Pasted specification'}
                    data-testid={
                      format === 'postman'
                        ? 'import-postman-paste'
                        : format === 'openapi'
                          ? 'import-openapi-paste'
                          : 'import-paste'
                    }
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    rows={8}
                    placeholder={
                      format === 'postman'
                        ? '{"info": {"name": "My Collection", ...}}'
                        : format === 'proto'
                          ? 'syntax = "proto3";\n\npackage example;\n\nservice Greeter { … }'
                          : 'Paste OpenAPI YAML/JSON, Postman collection JSON, WSDL XML or a .proto here…'
                    }
                    className="rounded border border-hairline-strong bg-surface-base p-2 font-mono text-xs text-fg-default outline-none"
                  />
                )}
              </div>

              {/* Target Project Selection */}
              <div className="mt-3 flex items-center gap-2">
                <label className="text-sm text-fg-subtle" htmlFor="import-target-project">
                  Into project
                </label>
                <select
                  id="import-target-project"
                  data-testid={
                    format === 'postman'
                      ? 'import-postman-target-project'
                      : format === 'openapi'
                        ? 'import-openapi-target-project'
                        : 'import-target-project'
                  }
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
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

              {/* Optional Name and Base URL (or gRPC target) overrides for REST and gRPC */}
              {(isRest || isProto) && (
                <>
                  <div className="mt-2 flex flex-col gap-1">
                    <label className="text-sm text-fg-subtle" htmlFor="import-name-override">
                      Name (optional)
                    </label>
                    <input
                      id="import-name-override"
                      data-testid={
                        format === 'postman'
                          ? 'import-postman-name'
                          : format === 'openapi'
                            ? 'import-openapi-name'
                            : 'import-name-input'
                      }
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={sourceName}
                      className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                    />
                  </div>

                  <div className="mt-2 flex flex-col gap-1">
                    <label className="text-sm text-fg-subtle" htmlFor="import-base-url-override">
                      {isProto ? 'Target (optional)' : 'Base URL (optional)'}
                    </label>
                    <input
                      id="import-base-url-override"
                      data-testid={
                        format === 'postman'
                          ? 'import-postman-base-url'
                          : format === 'openapi'
                            ? 'import-openapi-base-url'
                            : 'import-base-url-input'
                      }
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder={isProto ? 'host:port' : 'https://api.example.com'}
                      className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                    />
                  </div>
                  {isProto && (
                    <label className="mt-2 flex items-center gap-2 text-sm text-fg-subtle">
                      <input
                        type="checkbox"
                        data-testid="import-proto-tls"
                        checked={tls}
                        onChange={(e) => setTls(e.target.checked)}
                      />
                      The target speaks TLS (grpcs)
                    </label>
                  )}
                </>
              )}

              {(effectiveFormat === 'openapi' || isProto) && (
                <label className="mt-2 flex items-center gap-2 text-sm text-fg-subtle">
                  <input
                    type="checkbox"
                    data-testid="import-openapi-cache"
                    checked={cache}
                    onChange={(e) => setCache(e.target.checked)}
                  />
                  {isProto
                    ? 'Cache the .proto files with the project'
                    : 'Cache specification documents with the project'}
                </label>
              )}

              {progress !== undefined && (
                <p data-testid="import-openapi-progress" className="mt-3 truncate text-sm text-fg-subtle">
                  {progress}
                </p>
              )}
              {importError !== undefined && (
                <p
                  role="alert"
                  data-testid={
                    format === 'postman'
                      ? 'import-postman-error'
                      : format === 'openapi'
                        ? 'import-openapi-error'
                        : 'import-error'
                  }
                  className="mt-3 text-sm text-status-danger"
                >
                  {importError}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                {importing ? (
                  <Button
                    data-testid={
                      format === 'postman'
                        ? 'import-postman-cancel'
                        : format === 'openapi'
                          ? 'import-openapi-cancel'
                          : 'import-cancel'
                    }
                    onClick={() => void onCancel()}
                  >
                    Cancel
                  </Button>
                ) : (
                  <>
                    <Dialog.Close asChild>
                      <Button>Cancel</Button>
                    </Dialog.Close>
                    <Button
                      data-testid={
                        format === 'postman'
                          ? 'import-postman-submit'
                          : format === 'openapi'
                            ? 'import-openapi-submit'
                            : 'import-submit'
                      }
                      variant="primary"
                      onClick={() => void onImport()}
                    >
                      Import
                    </Button>
                  </>
                )}
              </div>
            </>
          ) : (
            <UnifiedSummary
              result={result}
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

function UnifiedSummary({ result, onDone }: { readonly result: UnifiedImportResult; readonly onDone: () => void }) {
  const updateApi = useProjectStore((state) => state.updateApi);
  const openApiSummary = result.kind === 'openapi' ? result.summary : undefined;
  const [applied, setApplied] = useState<string | undefined>(
    openApiSummary?.securitySchemes.find((scheme) => scheme.applied)?.name,
  );
  const usable = openApiSummary?.securitySchemes.filter((scheme) => scheme.auth !== undefined) ?? [];

  return (
    <div
      data-testid={
        result.kind === 'postman'
          ? 'import-postman-summary'
          : result.kind === 'openapi'
            ? 'import-openapi-summary'
            : result.kind === 'proto'
              ? 'import-proto-summary'
              : 'import-summary'
      }
      className="mt-3 flex flex-col gap-3"
    >
      {result.kind === 'openapi' && (
        <>
          <div className="rounded border border-hairline-strong p-2 text-sm text-fg-default">
            <p className="font-medium">{result.summary.name}</p>
            <p className="text-xs text-fg-subtle">
              OpenAPI {result.summary.declaredVersion}
              {result.summary.apiVersion !== undefined ? ` · API version ${result.summary.apiVersion}` : ''} ·{' '}
              {result.summary.baseUrl}
            </p>
            <p data-testid="import-openapi-counts" className="mt-1 text-sm">
              {result.summary.requests} request{result.summary.requests === 1 ? '' : 's'} in {result.summary.folders}{' '}
              folder
              {result.summary.folders === 1 ? '' : 's'}
              {result.summary.deprecated > 0 ? `, ${result.summary.deprecated} deprecated` : ''}.
            </p>
          </div>

          {result.summary.securitySchemes.length > 0 && (
            <div className="rounded border border-hairline-strong p-2">
              <p className="text-sm text-fg-default">Authentication</p>
              <p className="text-xs text-fg-subtle">
                {applied === undefined
                  ? 'The document does not say which scheme this API uses. Pick one, or set it up later on the API tab.'
                  : `Using “${applied}”. Credentials are yours to fill in on the API tab.`}
              </p>
              <ul data-testid="import-openapi-schemes" className="mt-1 flex flex-col gap-1">
                {result.summary.securitySchemes.map((scheme) => (
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
                            void updateApi(result.apiId, { auth: scheme.auth ?? null });
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

          {result.summary.skipped.length > 0 && (
            <div className="rounded border border-hairline-strong p-2">
              <p className="text-sm text-fg-default">
                {result.summary.skipped.length} thing{result.summary.skipped.length === 1 ? '' : 's'} not imported
              </p>
              <ul
                data-testid="import-openapi-skipped"
                className="mt-1 flex max-h-40 flex-col gap-1 overflow-auto text-xs text-fg-subtle"
              >
                {result.summary.skipped.map((entry, index) => (
                  <li key={index}>
                    <span className="text-fg-default">{entry.where}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {result.kind === 'postman' && (
        <div className="rounded border border-hairline-strong p-3 text-sm text-fg-default">
          <p className="font-semibold text-base">{result.summary.name}</p>
          {result.summary.description !== undefined && (
            <p className="mt-1 text-xs text-fg-subtle">{result.summary.description}</p>
          )}
          <p data-testid="import-postman-counts" className="mt-2 text-sm text-fg-default">
            {result.summary.requests} request{result.summary.requests === 1 ? '' : 's'} in {result.summary.folders}{' '}
            folder{result.summary.folders === 1 ? '' : 's'}.
          </p>
          {result.summary.auth !== undefined && (
            <p className="mt-1 text-xs text-fg-subtle">
              Default authentication: <span className="font-medium text-fg-default">{result.summary.auth}</span>
            </p>
          )}
        </div>
      )}

      {result.kind === 'proto' && (
        <div className="rounded border border-hairline-strong p-3 text-sm text-fg-default">
          <p className="font-semibold text-base">{result.summary.name}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            gRPC · {result.summary.target === '' ? 'no target yet — set one on the API tab' : result.summary.target}
          </p>
          <p data-testid="import-proto-counts" className="mt-2 text-sm text-fg-default">
            {result.summary.methods} method{result.summary.methods === 1 ? '' : 's'} in {result.summary.services}{' '}
            service{result.summary.services === 1 ? '' : 's'}, from {result.summary.files} file
            {result.summary.files === 1 ? '' : 's'}
            {result.summary.deprecated > 0 ? `, ${result.summary.deprecated} deprecated` : ''}.
          </p>
        </div>
      )}

      {result.kind === 'wsdl' && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="font-medium text-sm text-fg-default">{result.name}</p>
          <p className="text-xs text-fg-subtle">WSDL / SOAP Service</p>
          {result.problems.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-status-warning">{result.problems.length} problem(s) found during import:</p>
              <ul className="mt-1 flex flex-col gap-1 text-xs text-fg-subtle">
                {result.problems.map((problem, index) => (
                  <li key={index}>{problem.message}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  useUiStore.getState().showConsoleTab('problems');
                  onDone();
                }}
                className="mt-1 text-xs text-accent underline"
              >
                Show in Problems
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          data-testid={
            result.kind === 'postman'
              ? 'import-postman-done'
              : result.kind === 'openapi'
                ? 'import-openapi-done'
                : 'import-done'
          }
          variant="primary"
          onClick={onDone}
        >
          Done
        </Button>
      </div>
    </div>
  );
}
