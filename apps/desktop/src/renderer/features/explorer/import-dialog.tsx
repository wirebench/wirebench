/**
 * The Unified Import Dialog.
 *
 * Supports importing API definitions from:
 * - OpenAPI 3.0, 3.1, 3.2 and Swagger 1.x / 2.0 / 3.x (YAML / JSON)
 * - AsyncAPI 2.0–2.6 and 3.0 (YAML / JSON), as a WebSocket API
 * - Postman Collections (v2.0, v2.1 JSON)
 * - WSDL 1.1 / 2.0 (SOAP XML)
 * - Protocol Buffers `.proto` files (gRPC)
 * - Legacy single-XML SOAP projects (a whole project: interfaces, requests, environments)
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
  ApiAsyncApiServersRequest,
  AsyncApiImportSummaryWire,
  AuthConfigWire,
  EngineProgressEvent,
  GrpcReflectionVersionWire,
  ImportProblemWire,
  ImportSourceWire,
  LegacyImportReportWire,
  OpenApiImportSummaryWire,
  OpenApiSourceWire,
  PostmanImportSummaryWire,
  PostmanSourceWire,
  ProjectAddInterfaceTarget,
  ProtoImportSummaryWire,
  ProtoSourceWire,
} from '../../../shared/wire-types.js';
import { Button } from '../../components/button.js';
import { DefinitionAuthFields, NO_DEFINITION_AUTH, toDefinitionAuthWire } from '../../components/definition-auth.js';
import { SecretField } from '../../components/secret-field.js';
import { Tabs } from '../../components/tabs.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore, type ImportDialogFormat } from '../../state/ui.js';
import { getExplorerTree } from './explorer-api.js';

export type SourceTab = 'url' | 'file' | 'paste' | 'server';

/** The `import-target-project` value standing for *New project "<name>"*. Never a project id. */
export const NEW_PROJECT = '';

const TABS = [
  { id: 'url', label: 'URL' },
  { id: 'file', label: 'File' },
  { id: 'paste', label: 'Paste' },
] as const satisfies readonly { id: SourceTab; label: string }[];

/**
 * gRPC has a fifth way in that the other formats do not: a running server, asked to describe itself
 * over server reflection. It is offered only when the format is gRPC — auto-detection reads a
 * document, and there is no document here.
 */
const PROTO_TABS = [...TABS, { id: 'server', label: 'Server' }] as const satisfies readonly {
  id: SourceTab;
  label: string;
}[];

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
  | { readonly kind: 'asyncapi'; readonly apiId: string; readonly summary: AsyncApiImportSummaryWire }
  | { readonly kind: 'postman'; readonly apiId: string; readonly summary: PostmanImportSummaryWire }
  | { readonly kind: 'proto'; readonly apiId: string; readonly summary: ProtoImportSummaryWire }
  | { readonly kind: 'legacy'; readonly report: LegacyImportReportWire; readonly reportText: string };

export interface ImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialFormat?: ImportDialogFormat;
}

export function ImportDialog({ open, onOpenChange, initialFormat: propFormat }: ImportDialogProps) {
  const storeFormat = useUiStore((state) => state.importDialogFormat);
  const initialFmt = propFormat ?? storeFormat ?? 'auto';
  const [tab, setTab] = useState<SourceTab>(
    initialFmt === 'postman' || initialFmt === 'legacy-soap-project' ? 'file' : 'url',
  );
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
  // gRPC server reflection: the server to ask, which version to ask with, and whether to insist.
  const [serverTarget, setServerTarget] = useState('');
  const [reflectionVersion, setReflectionVersion] = useState<GrpcReflectionVersionWire>('auto');
  const [serverTrustInvalid, setServerTrustInvalid] = useState(false);
  // AsyncAPI: the document's WebSocket servers, read from main, and the one to dial.
  const [wsServers, setWsServers] = useState<readonly { readonly key: string; readonly url: string }[]>([]);
  // True from the moment an AsyncAPI source settles until main has answered which servers it has
  // (the debounce included): an Import before then would dial a server the user never got to pick.
  const [previewPending, setPreviewPending] = useState(false);
  const [wsServer, setWsServer] = useState('');
  // The preview (sent without credentials) answered that the document needs them.
  const [serversNeedAuth, setServersNeedAuth] = useState(false);
  const [loadingServers, setLoadingServers] = useState(false);

  // WSDL Basic Auth fields
  const [useAuth, setUseAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [passwordRef, setPasswordRef] = useState<string | undefined>(undefined);
  const passwordFlushRef = useRef<(() => Promise<string | undefined>) | undefined>(undefined);
  const registerPasswordFlush = useCallback((flush: (() => Promise<string | undefined>) | undefined) => {
    passwordFlushRef.current = flush;
  }, []);
  const [useForRequests, setUseForRequests] = useState(false);

  // OpenAPI and AsyncAPI by URL: the credentials the document is fetched with, as references.
  const [definitionAuth, setDefinitionAuth] = useState<AuthConfigWire>(NO_DEFINITION_AUTH);
  const definitionAuthFlushRef = useRef<(() => Promise<AuthConfigWire | undefined>) | undefined>(undefined);
  const registerDefinitionAuthFlush = useCallback((flush: (() => Promise<AuthConfigWire | undefined>) | undefined) => {
    definitionAuthFlushRef.current = flush;
  }, []);

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
    if (fmt === 'postman' || fmt === 'legacy-soap-project') {
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

  /*
   * An AsyncAPI document's servers are alternative addresses for one application, so the import
   * dials one of them. Which ones speak WebSocket is main's to read (the document may reference
   * other files); it is asked shortly after the source settles, and a stale answer is dropped.
   */
  const asyncApiSource: OpenApiSourceWire | undefined =
    effectiveFormat !== 'asyncapi'
      ? undefined
      : tab === 'paste'
        ? pasted.length > 0
          ? { kind: 'text', text: pasted }
          : undefined
        : tab === 'file'
          ? dropped !== undefined
            ? { kind: 'text', text: dropped.text, location: `dropped:${dropped.name}` }
            : filePath.length > 0
              ? { kind: 'file', path: filePath }
              : undefined
          : tab === 'url' && URL.canParse(url)
            ? { kind: 'url', url }
            : undefined;
  /*
   * The preview runs while the URL is still being typed, and every intermediate URL is a host of its
   * own (`…example.co` on the way to `…example.com`), so it never carries the credentials. When the
   * document answers that it needs them, **Load servers** asks once more, with them, for the URL as it
   * stands; Import always sends them.
   */
  const asyncApiSourceKey = asyncApiSource === undefined ? '' : JSON.stringify({ source: asyncApiSource });
  // The source the latest preview is for, so an answer for an older one is dropped.
  const previewKeyRef = useRef('');

  useEffect(() => {
    previewKeyRef.current = asyncApiSourceKey;
    setWsServers([]);
    setWsServer('');
    setServersNeedAuth(false);
    if (!open || asyncApiSourceKey === '') {
      setPreviewPending(false);
      return;
    }
    setPreviewPending(true);
    let current = true;
    const timer = setTimeout(() => {
      const request = JSON.parse(asyncApiSourceKey) as ApiAsyncApiServersRequest;
      void ipc()
        .api.asyncApiServers(request)
        .then((res) => {
          if (!current) {
            return; // A newer source has its own preview under way.
          }
          setPreviewPending(false);
          if (!res.ok) {
            // A document that cannot be read yet says so on Import; the picker just stays away, unless
            // the credentials in the form may be what it lacks.
            setServersNeedAuth(res.error.code === 'definition-auth-required' && request.source.kind === 'url');
            return;
          }
          setWsServers(res.value.servers);
          setWsServer(res.value.servers[0]?.key ?? '');
        })
        .catch(() => {
          if (current) setPreviewPending(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, asyncApiSourceKey]);

  /** Asks for the servers again, with the form's credentials, for the URL as it stands now. */
  async function loadServersWithAuth(): Promise<void> {
    const key = asyncApiSourceKey;
    if (key === '') {
      return;
    }
    const { source } = JSON.parse(key) as ApiAsyncApiServersRequest;
    setLoadingServers(true);
    try {
      const auth = toDefinitionAuthWire((await definitionAuthFlushRef.current?.()) ?? definitionAuth);
      const res = await ipc().api.asyncApiServers({ source, ...(auth !== undefined ? { auth } : {}) });
      if (previewKeyRef.current !== key) {
        return; // The URL moved on while this was out.
      }
      if (res.ok) {
        setServersNeedAuth(false);
        setWsServers(res.value.servers);
        setWsServer(res.value.servers[0]?.key ?? '');
      }
    } catch {
      // Import reports what is wrong with the document; the button stays for another try.
    } finally {
      setLoadingServers(false);
    }
  }

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
    setServerTarget('');
    setReflectionVersion('auto');
    setServerTrustInvalid(false);
    setWsServers([]);
    setWsServer('');
    setServersNeedAuth(false);
    setDefinitionAuth(NO_DEFINITION_AUTH);
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
      effectiveFormat === 'legacy-soap-project'
        ? [
            { name: 'Legacy SOAP project', extensions: ['xml'] },
            { name: 'All Files', extensions: ['*'] },
          ]
        : effectiveFormat === 'postman'
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
              : effectiveFormat === 'asyncapi'
                ? [
                    { name: 'AsyncAPI Document', extensions: ['json', 'yaml', 'yml'] },
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
      effectiveFormat === 'legacy-soap-project'
        ? 'Import Legacy SOAP Project'
        : effectiveFormat === 'postman'
          ? 'Import Postman Collection'
          : effectiveFormat === 'proto'
            ? 'Import .proto'
            : effectiveFormat === 'openapi'
              ? 'Import OpenAPI Specification'
              : effectiveFormat === 'asyncapi'
                ? 'Import AsyncAPI Document'
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

  /**
   * The gRPC-only path: a running server asked to describe itself. It shares the import's token,
   * progress and cancellation, but has no document to read, so it skips {@link buildSource}.
   */
  async function importFromServer(): Promise<void> {
    const trimmed = serverTarget.trim();
    if (trimmed === '') {
      setImportError('Enter the server to ask, as host:port');
      return;
    }
    const token = crypto.randomUUID();
    tokenRef.current = token;
    setImporting(true);
    const chosen = openProjects.some((project) => project.id === target) ? target : NEW_PROJECT;
    const into: ProjectAddInterfaceTarget = chosen === NEW_PROJECT ? { newProjectName } : { projectId: chosen };
    try {
      const imported = await useProjectStore.getState().importProto({
        target: into,
        source: {
          kind: 'reflection',
          target: trimmed,
          tls,
          version: reflectionVersion,
          ...(serverTrustInvalid ? { trustInvalid: true } : {}),
        },
        cache,
        tls,
        token,
        // The API is called at the same address it was discovered from unless the user said otherwise.
        grpcTarget: baseUrl.trim().length > 0 ? baseUrl.trim() : trimmed,
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      });
      if (cancelledTokensRef.current.has(token)) {
        return;
      }
      getExplorerTree()?.open(`proj:${imported.projectId}`);
      setResult({ kind: 'proto', apiId: imported.apiId, summary: imported.summary });
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

  /**
   * A legacy SOAP project is a whole project, read by main from the file the user picked: main
   * needs the path (and the dialog's evidence that it was picked), so a dropped or pasted copy
   * is not enough.
   */
  async function importLegacyProject(source: ImportSourceWire): Promise<void> {
    if (source.kind !== 'file') {
      setImportError('Choose the project file with Browse…. A legacy project is imported from the file itself.');
      return;
    }
    const token = crypto.randomUUID();
    tokenRef.current = token;
    setImporting(true);
    const chosen = openProjects.some((project) => project.id === target) ? target : NEW_PROJECT;
    try {
      const res = await ipc().project.importLegacy({
        // An empty name asks main to use the one the file gives the project.
        target: chosen === NEW_PROJECT ? { newProjectName: name.trim() } : { projectId: chosen },
        source: { kind: 'file', path: source.path },
        token,
      });
      if (cancelledTokensRef.current.has(token)) {
        return;
      }
      if (!res.ok) {
        setImportError(res.error.message);
        return;
      }
      getExplorerTree()?.open(`proj:${res.value.projectId}`);
      setResult({ kind: 'legacy', report: res.value.report, reportText: res.value.reportText });
    } finally {
      cancelledTokensRef.current.delete(token);
      if (tokenRef.current === token) {
        tokenRef.current = undefined;
      }
      setImporting(false);
      setProgress(undefined);
    }
  }

  async function onImport(): Promise<void> {
    if (importing) {
      return;
    }
    setImportError(undefined);
    if (tab === 'server') {
      await importFromServer();
      return;
    }
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

    if (effectiveFormat === 'legacy-soap-project') {
      await importLegacyProject(source);
      return;
    }

    // Determine target format
    let targetFormat: 'wsdl' | 'openapi' | 'asyncapi' | 'postman' | 'proto';
    if (effectiveFormat === 'wsdl') {
      targetFormat = 'wsdl';
    } else if (effectiveFormat === 'proto') {
      targetFormat = 'proto';
    } else if (effectiveFormat === 'postman') {
      targetFormat = 'postman';
    } else if (effectiveFormat === 'openapi') {
      targetFormat = 'openapi';
    } else if (effectiveFormat === 'asyncapi') {
      targetFormat = 'asyncapi';
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
      // Only a URL is fetched from anywhere, so only a URL carries credentials; a secret typed but not
      // yet saved is stored first, as the WSDL password is below.
      const definitionAuthWire =
        source.kind === 'url' && (targetFormat === 'openapi' || targetFormat === 'asyncapi')
          ? toDefinitionAuthWire((await definitionAuthFlushRef.current?.()) ?? definitionAuth)
          : undefined;
      const withDefinitionAuth = definitionAuthWire !== undefined ? { auth: definitionAuthWire } : {};

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
          ...withDefinitionAuth,
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
      } else if (targetFormat === 'asyncapi') {
        const imported = await useProjectStore.getState().importAsyncApi({
          target: into,
          source:
            source.kind === 'url'
              ? { kind: 'url', url: source.url }
              : source.kind === 'file'
                ? { kind: 'file', path: source.path }
                : {
                    kind: 'text',
                    text: source.text,
                    ...(source.location !== undefined ? { location: source.location } : {}),
                  },
          cache,
          token,
          // Named only when there was a choice: with one server, main's default is that server.
          ...(wsServers.length > 1 && wsServer !== '' ? { server: wsServer } : {}),
          ...(name.trim().length > 0 ? { name: name.trim() } : {}),
          ...withDefinitionAuth,
        });
        if (cancelledTokensRef.current.has(token)) {
          return;
        }
        getExplorerTree()?.open(`proj:${imported.projectId}`);
        setResult({ kind: 'asyncapi', apiId: imported.apiId, summary: imported.summary });
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
  const isAsyncApi = effectiveFormat === 'asyncapi';

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
                    : format === 'asyncapi'
                      ? 'Import AsyncAPI'
                      : format === 'wsdl'
                        ? 'Import WSDL'
                        : format === 'proto'
                          ? 'Import .proto'
                          : format === 'legacy-soap-project'
                            ? 'Import Legacy SOAP Project'
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
                    onChange={(e) => {
                      const next = e.target.value as ImportDialogFormat;
                      setFormat(next);
                      // Only gRPC can be imported from a running server; leaving it takes the tab with it.
                      if (next !== 'proto' && tab === 'server') {
                        setTab('url');
                      }
                    }}
                    className="rounded border border-hairline-strong bg-surface-base px-2 py-1 text-xs text-fg-default outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="openapi">OpenAPI / Swagger</option>
                    <option value="asyncapi">AsyncAPI (WebSocket)</option>
                    <option value="postman">Postman Collection</option>
                    <option value="wsdl">WSDL (SOAP)</option>
                    <option value="proto">Protocol Buffers (gRPC)</option>
                    <option value="legacy-soap-project">Legacy SOAP project</option>
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
                {/*
                  `tab === 'server'` keeps the tab while its own panel is up. Under Auto-detect the
                  detection reads the current tab's input, and the Server tab has none — so selecting
                  it makes `effectiveFormat` fall back to `unknown`, which would otherwise drop the
                  very tab the user just picked and leave the strip with nothing selected above a
                  Server panel.
                */}
                <Tabs
                  label="Import source"
                  items={isProto || tab === 'server' ? PROTO_TABS : TABS}
                  active={tab}
                  onSelect={setTab}
                />
              </div>

              <div className="mt-3 flex flex-col gap-2">
                {tab === 'url' && (
                  <>
                    <label className="text-sm text-fg-subtle" htmlFor="import-url">
                      {effectiveFormat === 'openapi' || effectiveFormat === 'postman' || isAsyncApi
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

                    {(effectiveFormat === 'openapi' || effectiveFormat === 'asyncapi') && (
                      <DefinitionAuthFields
                        auth={definitionAuth}
                        onChange={setDefinitionAuth}
                        registerFlush={registerDefinitionAuthFlush}
                      />
                    )}

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

                {tab === 'server' && (
                  <>
                    <label className="text-sm text-fg-subtle" htmlFor="import-reflection-target">
                      Server address
                    </label>
                    <input
                      id="import-reflection-target"
                      data-testid="import-reflection-target"
                      value={serverTarget}
                      onChange={(e) => setServerTarget(e.target.value)}
                      placeholder="host:port"
                      className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                    />
                    <p className="text-xs text-fg-subtle">
                      The server is asked to describe itself over gRPC server reflection. No .proto files are needed.
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <label className="text-xs text-fg-subtle" htmlFor="import-reflection-version">
                        Reflection version
                      </label>
                      <select
                        id="import-reflection-version"
                        data-testid="import-reflection-version"
                        value={reflectionVersion}
                        onChange={(e) => setReflectionVersion(e.target.value as GrpcReflectionVersionWire)}
                        className="rounded border border-hairline-strong bg-surface-base px-2 py-1 text-xs text-fg-default outline-none focus:ring-1 focus:ring-accent"
                      >
                        <option value="auto">Automatic (v1, then v1alpha)</option>
                        <option value="v1">v1</option>
                        <option value="v1alpha">v1alpha</option>
                      </select>
                    </div>
                    <label className="mt-1 flex items-center gap-2 text-sm text-fg-subtle">
                      <input
                        type="checkbox"
                        data-testid="import-reflection-trust-invalid"
                        checked={serverTrustInvalid}
                        onChange={(e) => setServerTrustInvalid(e.target.checked)}
                      />
                      Ask even if the certificate does not verify
                    </label>
                  </>
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
                  <option value={NEW_PROJECT}>
                    {effectiveFormat === 'legacy-soap-project' && name.trim() === ''
                      ? 'New project, named as in the file'
                      : `New project “${newProjectName}”`}
                  </option>
                </select>
              </div>

              {effectiveFormat === 'legacy-soap-project' && target === NEW_PROJECT && (
                <div className="mt-2 flex flex-col gap-1">
                  <label className="text-sm text-fg-subtle" htmlFor="import-legacy-project-name">
                    New project name (optional)
                  </label>
                  <input
                    id="import-legacy-project-name"
                    data-testid="import-legacy-project-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="As named in the file"
                    className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              )}

              {isAsyncApi && (
                <>
                  <div className="mt-2 flex flex-col gap-1">
                    <label className="text-sm text-fg-subtle" htmlFor="import-asyncapi-name">
                      Name (optional)
                    </label>
                    <input
                      id="import-asyncapi-name"
                      data-testid="import-asyncapi-name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="As titled in the document"
                      className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                    />
                  </div>
                  {serversNeedAuth && tab === 'url' && (
                    <div className="mt-2 flex items-center gap-2">
                      <p className="text-sm text-fg-subtle">The document’s servers need authentication to read.</p>
                      <Button
                        data-testid="import-asyncapi-load-servers"
                        aria-label="Load servers with these credentials"
                        disabled={loadingServers}
                        onClick={() => {
                          void loadServersWithAuth();
                        }}
                      >
                        Load servers
                      </Button>
                    </div>
                  )}
                  {wsServers.length > 1 && (
                    <div className="mt-2 flex flex-col gap-1">
                      <label className="text-sm text-fg-subtle" htmlFor="import-asyncapi-server">
                        WebSocket server
                      </label>
                      <select
                        id="import-asyncapi-server"
                        data-testid="import-asyncapi-server"
                        value={wsServer}
                        onChange={(e) => setWsServer(e.target.value)}
                        className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                      >
                        {wsServers.map((server) => (
                          <option key={server.key} value={server.key}>
                            {server.key} — {server.url}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </>
              )}

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

              {(effectiveFormat === 'openapi' || isAsyncApi || isProto) && (
                <label className="mt-2 flex items-center gap-2 text-sm text-fg-subtle">
                  <input
                    type="checkbox"
                    data-testid="import-openapi-cache"
                    checked={cache}
                    onChange={(e) => setCache(e.target.checked)}
                  />
                  {isProto
                    ? tab === 'server'
                      ? 'Cache the discovered descriptors with the project'
                      : 'Cache the .proto files with the project'
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
                      disabled={effectiveFormat === 'asyncapi' && previewPending}
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
            : result.kind === 'asyncapi'
              ? 'import-asyncapi-summary'
              : result.kind === 'proto'
                ? 'import-proto-summary'
                : result.kind === 'legacy'
                  ? 'import-legacy-summary'
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

      {result.kind === 'asyncapi' && <AsyncApiSummary summary={result.summary} />}

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

      {result.kind === 'postman' && (result.summary.warnings?.length ?? 0) > 0 && (
        <PostmanWarnings name={result.summary.name} warnings={result.summary.warnings ?? []} />
      )}

      {result.kind === 'proto' && (
        <div className="rounded border border-hairline-strong p-3 text-sm text-fg-default">
          <p className="font-semibold text-base">{result.summary.name}</p>
          <p className="mt-1 text-xs text-fg-subtle">
            gRPC · {result.summary.target === '' ? 'no target yet — set one on the API tab' : result.summary.target}
            {result.summary.kind === 'reflection'
              ? ` · discovered by server reflection${
                  result.summary.reflectionVersion !== undefined ? ` (${result.summary.reflectionVersion})` : ''
                }`
              : ''}
          </p>
          <p data-testid="import-proto-counts" className="mt-2 text-sm text-fg-default">
            {result.summary.methods} method{result.summary.methods === 1 ? '' : 's'} in {result.summary.services}{' '}
            service{result.summary.services === 1 ? '' : 's'}, from {result.summary.files} file
            {result.summary.files === 1 ? '' : 's'}
            {result.summary.deprecated > 0 ? `, ${result.summary.deprecated} deprecated` : ''}.
          </p>
        </div>
      )}

      {result.kind === 'legacy' && <LegacySummary report={result.report} reportText={result.reportText} />}

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

/**
 * What an AsyncAPI import made — requests and the messages saved on them — and, one line each, the
 * channels, servers and schemes it left out, since a skipped Kafka channel is otherwise silent.
 */
export function AsyncApiSummary({ summary }: { readonly summary: AsyncApiImportSummaryWire }) {
  const plural = (n: number, word: string): string => `${String(n)} ${n === 1 ? word : `${word}s`}`;
  const skipped = summary.skipped;
  return (
    <>
      <div className="rounded border border-hairline-strong p-2 text-sm text-fg-default">
        <p className="font-medium">{summary.name}</p>
        <p className="text-xs text-fg-subtle">
          AsyncAPI {summary.declaredVersion}
          {summary.server !== undefined ? ` · server ${summary.server}` : ' · no WebSocket server'}
        </p>
        <p data-testid="import-asyncapi-counts" className="mt-1 text-sm">
          {plural(summary.requests, 'request')}, {plural(summary.messages, 'message')}.
        </p>
        {summary.unresolved.length > 0 && (
          <p data-testid="import-asyncapi-unresolved" className="mt-1 text-xs text-fg-subtle">
            Left as properties to define: {summary.unresolved.map((name) => `\${${name}}`).join(', ')}
          </p>
        )}
        {summary.unsupportedKeywords.length > 0 && (
          <p data-testid="import-asyncapi-unsupported" className="mt-1 text-xs text-fg-subtle">
            Schema keywords the contract check does not assert: {summary.unsupportedKeywords.join(', ')}
          </p>
        )}
      </div>
      {skipped.length > 0 && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="text-sm text-fg-default">Skipped ({String(skipped.length)})</p>
          <ul
            data-testid="import-asyncapi-skipped"
            className="mt-1 flex max-h-40 flex-col gap-1 overflow-auto text-xs text-fg-subtle"
          >
            {skipped.map((entry, index) => (
              <li key={index}>
                <span className="text-fg-default">{entry.where}</span> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** What a legacy SOAP project import brought across, and one line for everything it did not. */
function LegacySummary({
  report,
  reportText,
}: {
  readonly report: LegacyImportReportWire;
  readonly reportText: string;
}) {
  const { counts } = report;
  const warnings = report.items.filter((item) => item.severity === 'warning');
  const notes = report.items.filter((item) => item.severity === 'info');
  const plural = (n: number, word: string, many = `${word}s`): string => `${String(n)} ${n === 1 ? word : many}`;
  return (
    <>
      <div className="rounded border border-hairline-strong p-3 text-sm text-fg-default">
        <p className="font-semibold text-base">{report.projectName}</p>
        <p className="mt-1 text-xs text-fg-subtle">Legacy SOAP project</p>
        <p data-testid="import-legacy-counts" className="mt-2 text-sm text-fg-default">
          {plural(counts.interfaces, 'interface')}, {plural(counts.requests, 'request')} in{' '}
          {plural(counts.operations, 'operation')}, {plural(counts.environments, 'environment')},{' '}
          {plural(counts.properties, 'property', 'properties')}
          {counts.scripts > 0 ? `, ${plural(counts.scripts, 'script')} kept in imported-scripts/` : ''}.
        </p>
      </div>
      {warnings.length > 0 && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="text-sm text-status-warning">{plural(warnings.length, 'thing')} to look at</p>
          <ReportItems items={warnings} testId="import-legacy-warnings" />
        </div>
      )}
      {notes.length > 0 && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="text-sm text-fg-default">{plural(notes.length, 'note')}</p>
          <ReportItems items={notes} testId="import-legacy-notes" />
        </div>
      )}
      <CopyReport text={reportText} testId="import-legacy-copy-report" />
    </>
  );
}

/**
 * What a Postman import did not bring across: scripts, variables, credentials to re-enter,
 * unsupported auth. The engine words each line; the report copies them under the collection name.
 */
function PostmanWarnings({ name, warnings }: { readonly name: string; readonly warnings: readonly string[] }) {
  const items = warnings.map((message) => ({ path: '', message }));
  const count = `${String(warnings.length)} ${warnings.length === 1 ? 'thing' : 'things'}`;
  const reportText = [`Postman collection "${name}"`, ...warnings.map((w) => `- ${w}`)].join('\n');
  return (
    <>
      <div className="rounded border border-hairline-strong p-2">
        <p className="text-sm text-status-warning">{count} to look at</p>
        <ReportItems items={items} testId="import-postman-warnings" />
      </div>
      <CopyReport text={reportText} testId="import-postman-copy-report" />
    </>
  );
}

/** One line per report item, its path first when it has one. */
function ReportItems({
  items,
  testId,
}: {
  readonly items: readonly { readonly path: string; readonly message: string }[];
  readonly testId: string;
}) {
  return (
    <ul data-testid={testId} className="mt-1 flex max-h-40 flex-col gap-1 overflow-auto text-xs text-fg-subtle">
      {items.map((item, index) => (
        <li key={index}>
          {item.path !== '' && <span className="text-fg-default">{item.path}</span>}
          {item.path !== '' && ' — '}
          {item.message}
        </li>
      ))}
    </ul>
  );
}

/** Puts an import report on the clipboard, for a ticket or a migration checklist. */
function CopyReport({ text, testId }: { readonly text: string; readonly testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex justify-start">
      <button
        type="button"
        data-testid={testId}
        className="text-xs text-accent underline"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy report'}
      </button>
    </div>
  );
}
