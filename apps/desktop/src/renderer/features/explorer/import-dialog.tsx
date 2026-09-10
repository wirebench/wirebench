import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { EngineProgressEvent, ImportProblemWire, ImportSourceWire } from '../../../shared/wire-types.js';
import { Button } from '../../components/button.js';
import { SecretField } from '../../components/secret-field.js';
import { Tabs } from '../../components/tabs.js';
import { ipc } from '../../state/ipc-client.js';
import { useProblemsStore } from '../../state/problems.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { projectActions } from '../welcome/project-actions.js';

type SourceTab = 'url' | 'file' | 'paste';

const TABS = [
  { id: 'url', label: 'URL' },
  { id: 'file', label: 'File' },
  { id: 'paste', label: 'Paste' },
] as const satisfies readonly { id: SourceTab; label: string }[];

export interface ImportDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The Import WSDL dialog: pick a source (URL/File/Paste), track progress, show problems. */
export function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const [tab, setTab] = useState<SourceTab>('url');
  const [url, setUrl] = useState('');
  const [useAuth, setUseAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [passwordRef, setPasswordRef] = useState<string | undefined>(undefined);
  const passwordFlushRef = useRef<(() => Promise<string | undefined>) | undefined>(undefined);
  const registerPasswordFlush = useCallback((flush: (() => Promise<string | undefined>) | undefined) => {
    passwordFlushRef.current = flush;
  }, []);
  const [useForRequests, setUseForRequests] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [pasted, setPasted] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [problems, setProblems] = useState<ImportProblemWire[]>([]);
  // An import has to land somewhere: with no project open the dialog offers to make one first.
  const [needsProject, setNeedsProject] = useState(false);
  const tokenRef = useRef<string | undefined>(undefined);
  // Tokens for imports the user cancelled — the in-flight promise still settles after `onCancel`
  // returns, so its resolution/rejection must be ignored rather than surfaced as an error.
  const cancelledTokensRef = useRef<Set<string>>(new Set());

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

  function reset(): void {
    setImportError(undefined);
    setProgress(undefined);
    setProblems([]);
    setNeedsProject(false);
  }

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
      return filePath.length > 0 ? { kind: 'file', path: filePath } : undefined;
    }
    return pasted.length > 0 ? { kind: 'text', text: pasted } : undefined;
  }

  async function browseForFile(): Promise<void> {
    const result = await ipc().dialogs.openFile({
      title: 'Import WSDL',
      filters: [{ name: 'WSDL/XML', extensions: ['wsdl', 'xml'] }],
    });
    if (result.ok && result.value.path !== undefined) {
      setFilePath(result.value.path);
    }
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file !== undefined) {
      setFilePath(window.wirebench.files.pathFor(file));
    }
  }

  async function onImport(): Promise<void> {
    if (importing) {
      // Guards against a double submit racing two imports under one token.
      return;
    }
    reset();
    const source = buildSource();
    if (source === undefined) {
      return;
    }
    if (useProjectStore.getState().project === null) {
      setNeedsProject(true);
      return;
    }
    // A password typed but not Saved must not be silently dropped by pressing Import.
    const flushedRef = (await passwordFlushRef.current?.()) ?? passwordRef;

    const token = crypto.randomUUID();
    tokenRef.current = token;
    setImporting(true);
    try {
      const options =
        useAuth && username.length > 0 && flushedRef !== undefined
          ? { auth: { username, passwordRef: flushedRef }, useForRequests }
          : undefined;
      const summary = await useProjectStore.getState().importDefinition(source, options, token);
      if (cancelledTokensRef.current.has(token)) {
        return;
      }
      useProblemsStore.getState().set(summary.id, summary.problems);
      setProblems(summary.problems);
      if (summary.problems.length === 0) {
        onOpenChange(false);
      }
    } catch (error) {
      if (cancelledTokensRef.current.has(token)) {
        // The user already cancelled this import; its rejection is expected, not an error.
        return;
      }
      setImportError(error instanceof Error ? error.message : 'Import failed');
    } finally {
      cancelledTokensRef.current.delete(token);
      if (tokenRef.current === token) {
        tokenRef.current = undefined;
      }
      setImporting(false);
    }
  }

  async function onCancel(): Promise<void> {
    const token = tokenRef.current;
    if (token !== undefined) {
      cancelledTokensRef.current.add(token);
      await ipc().definition.cancelImport({ token });
    }
    setImporting(false);
    setProgress(undefined);
  }

  function showInProblems(): void {
    useUiStore.getState().showConsoleTab('problems');
    onOpenChange(false);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className="fixed top-1/2 left-1/2 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg">
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">Import WSDL</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-3">
            <Tabs label="Import source" items={TABS} active={tab} onSelect={setTab} />
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {tab === 'url' && (
              <>
                <label className="text-sm text-fg-subtle" htmlFor="import-url">
                  WSDL URL
                </label>
                <input
                  id="import-url"
                  data-testid="import-url-input"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="http://example.test/service.wsdl"
                  className="rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                />
                {urlError !== undefined && <p className="text-sm text-danger">{urlError}</p>}

                <label className="mt-2 flex items-center gap-2 text-sm text-fg-subtle">
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

            {tab === 'file' && (
              <>
                <div className="flex gap-2">
                  <input
                    aria-label="File path"
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                    placeholder="/path/to/service.wsdl"
                    className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm outline-none"
                  />
                  <Button onClick={() => void browseForFile()}>Browse…</Button>
                </div>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={onDrop}
                  className="flex h-20 items-center justify-center rounded border border-dashed border-hairline-strong text-sm text-fg-subtle"
                >
                  Drop a .wsdl or .xml file here
                </div>
              </>
            )}

            {tab === 'paste' && (
              <textarea
                aria-label="Pasted WSDL"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={8}
                className="rounded border border-hairline-strong bg-surface-base p-2 font-mono text-xs text-fg-default outline-none"
              />
            )}
          </div>

          {needsProject && (
            <div data-testid="import-needs-project" className="mt-3 rounded border border-hairline-strong p-2">
              <p className="text-sm text-fg-default">
                Interfaces are saved into a project folder. Create one to import into.
              </p>
              <div className="mt-2 flex gap-2">
                <Button variant="primary" onClick={() => void projectActions.newProject()}>
                  Create a project folder…
                </Button>
                <Button onClick={() => void projectActions.openProject()}>Open an existing project…</Button>
              </div>
            </div>
          )}

          {progress !== undefined && <p className="mt-3 text-sm text-fg-subtle">{progress}</p>}
          {importError !== undefined && <p className="mt-3 text-sm text-danger">{importError}</p>}

          {problems.length > 0 && (
            <div className="mt-3 rounded border border-hairline-strong p-2">
              <p className="text-sm text-fg-default">{problems.length} problem(s) found.</p>
              <ul className="mt-1 flex flex-col gap-1 text-xs text-fg-subtle">
                {problems.map((problem, index) => (
                  <li key={index}>{problem.message}</li>
                ))}
              </ul>
              <button type="button" onClick={showInProblems} className="mt-1 text-xs text-accent underline">
                Show in Problems
              </button>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            {importing ? (
              <Button onClick={() => void onCancel()}>Cancel</Button>
            ) : (
              <>
                <Dialog.Close asChild>
                  <Button>Cancel</Button>
                </Dialog.Close>
                <Button data-testid="import-submit" variant="primary" onClick={() => void onImport()}>
                  Import
                </Button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
