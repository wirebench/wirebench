/**
 * The selected host's session logs (#414), in its details slide-over: the switch that turns logging on for
 * this host (or shows the group it follows), and the logs this machine kept, searchable, each opened,
 * revealed or deleted from its row. Nothing here reads a file: main answers by host and log id.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, FolderOpen, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import type { SessionLogEntryWire, SessionLogMatchWire } from '../../../shared/session-log-wire.js';
import { resolveLogSwitch } from '../../../shared/session-log-switch.js';
import { useLogSwitchesStore } from './session-log-switches.js';

const SWITCH_CLASS =
  'inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-hairline-strong px-0.5 transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none';
const ICON_BUTTON =
  'inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default disabled:opacity-40';

export interface HostSessionLogsProps {
  readonly hostId: string;
  /** The host's group ids, root first: a group's switch applies when the host has none of its own. */
  readonly path: readonly string[];
  readonly groupName: (id: string) => string;
  /** Changes when a session to the host opens or closes, so the list reads again. */
  readonly refreshKey?: unknown;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function ending(entry: SessionLogEntryWire): string {
  if (entry.live) return 'running';
  if (entry.reason === 'lost') return 'connection lost';
  if (entry.reason === 'exit' && entry.exitCode !== undefined && entry.exitCode !== null) {
    return `exit ${String(entry.exitCode)}`;
  }
  return 'closed';
}

/** Says why a call failed, once, as a toast. */
function failed(result: { ok: false; error: { message: string } }): void {
  showToast(result.error.message);
}

export function HostSessionLogs({ hostId, path, groupName, refreshKey }: HostSessionLogsProps) {
  const switches = useLogSwitchesStore((s) => s.switches);
  const [logs, setLogs] = useState<readonly SessionLogEntryWire[]>([]);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<readonly SessionLogMatchWire[] | undefined>(undefined);
  const [opened, setOpened] = useState<SessionLogEntryWire | undefined>(undefined);
  const [deleting, setDeleting] = useState<SessionLogEntryWire | undefined>(undefined);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    void (async () => {
      const [, listed] = await Promise.all([useLogSwitchesStore.getState().load(), ipc().sessionLog.list({ hostId })]);
      if (current) setLogs(listed.ok ? listed.value.logs : []);
    })().catch(() => {
      // The section stays as it was: nothing to read is not worth a message.
    });
    return () => {
      current = false;
    };
  }, [hostId, refreshKey, version]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === '') {
      setMatches(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void ipc()
        .sessionLog.search({ hostId, query: trimmed })
        .then((result) => {
          if (current) setMatches(result.ok ? result.value.matches : []);
        })
        .catch(() => {
          if (current) setMatches([]);
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [hostId, query, version]);

  const resolved = resolveLogSwitch(switches, hostId, path);
  const source =
    resolved.from === 'host'
      ? 'set on host'
      : resolved.from === 'default'
        ? 'off unless turned on'
        : `from ${groupName(resolved.from.group)}`;

  const setSwitch = (on: boolean | null): Promise<void> =>
    useLogSwitchesStore.getState().set({ kind: 'host', id: hostId }, on);

  const matchOf = (id: string): SessionLogMatchWire | undefined => matches?.find((m) => m.id === id);
  const shown = matches === undefined ? logs : logs.filter((entry) => matchOf(entry.id) !== undefined);

  return (
    <section aria-label="Session logs" className="flex flex-col border-t border-hairline px-1 py-3">
      <h3 className="mb-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Session logs</h3>
      <div className="flex items-center gap-2 py-1 text-sm text-fg-default">
        <span>Log sessions</span>
        <button
          type="button"
          role="switch"
          aria-checked={resolved.on}
          aria-label="Log sessions"
          onClick={() => {
            void setSwitch(!resolved.on);
          }}
          className={`${SWITCH_CLASS} ${resolved.on ? 'justify-end bg-accent' : 'justify-start bg-surface-base'}`}
        >
          <span className="size-2.5 rounded-full bg-fg-default" />
        </button>
        <span className="truncate text-xs text-fg-subtle">{source}</span>
        {resolved.from === 'host' && path.length > 0 && (
          <button
            type="button"
            className="ml-auto text-xs text-fg-subtle underline hover:text-fg-default"
            onClick={() => {
              void setSwitch(null);
            }}
          >
            Follow group
          </button>
        )}
      </div>
      <p className="pb-1 text-xs text-fg-subtle">
        Output only, kept on this machine as plain text; secrets used to sign in or typed by a snippet are masked.
      </p>
      {logs.length > 0 && (
        <input
          type="search"
          aria-label="Search session logs"
          placeholder="Search logs"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="my-1 h-7 rounded border border-hairline bg-surface-sunken px-2 text-sm text-fg-default"
        />
      )}
      {logs.length === 0 ? (
        <p className="py-1 text-sm text-fg-subtle">No logs on this machine.</p>
      ) : shown.length === 0 ? (
        <p className="py-1 text-sm text-fg-subtle">No log contains that text.</p>
      ) : (
        <ul aria-label="Logs" className="flex flex-col">
          {shown.map((entry) => {
            const match = matchOf(entry.id);
            return (
              <li key={entry.id} data-testid="session-log-row" className="flex flex-col py-1">
                <div className="flex items-center gap-2 text-sm text-fg-default">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left hover:underline"
                    onClick={() => {
                      setOpened(entry);
                    }}
                  >
                    {when(entry.startedAt)}
                  </button>
                  <span className="truncate text-xs text-fg-subtle">
                    {ending(entry)} · {size(entry.bytes)}
                  </span>
                  <span className="ml-auto flex items-center">
                    <button
                      type="button"
                      aria-label="Open log"
                      title="Open"
                      className={ICON_BUTTON}
                      onClick={() => {
                        setOpened(entry);
                      }}
                    >
                      <FileText size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Reveal log file"
                      title="Reveal the file"
                      className={ICON_BUTTON}
                      onClick={() => {
                        void ipc()
                          .sessionLog.reveal({ hostId, id: entry.id })
                          .then((result) => {
                            if (!result.ok) failed(result);
                          })
                          .catch(() => {
                            showToast('The log file could not be shown');
                          });
                      }}
                    >
                      <FolderOpen size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete log"
                      title={entry.live ? 'Close the session to delete its log' : 'Delete'}
                      disabled={entry.live}
                      className={ICON_BUTTON}
                      onClick={() => {
                        setDeleting(entry);
                      }}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </span>
                </div>
                {match !== undefined && (
                  <p className="truncate font-mono text-xs text-fg-subtle" title={match.text}>
                    {`${String(match.line)}: ${match.text}`}
                    {match.count > 1 && ` (+${String(match.count - 1)} more)`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <LogViewer
        hostId={hostId}
        entry={opened}
        initialFilter={query.trim()}
        onClose={() => {
          setOpened(undefined);
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title="Delete this log?"
        description={
          deleting === undefined
            ? ''
            : `The log of the session started ${when(deleting.startedAt)} is deleted from this machine.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const entry = deleting;
          setDeleting(undefined);
          if (entry === undefined) return;
          void ipc()
            .sessionLog.delete({ hostId, id: entry.id })
            .then((result) => {
              if (!result.ok) failed(result);
            })
            .catch(() => {
              showToast('The log could not be deleted');
            })
            .finally(() => {
              setVersion((v) => v + 1);
            });
        }}
      />
    </section>
  );
}

/** One log's text, with a filter that keeps only the lines containing it (case-insensitive). */
function LogViewer({
  hostId,
  entry,
  initialFilter,
  onClose,
}: {
  readonly hostId: string;
  readonly entry: SessionLogEntryWire | undefined;
  readonly initialFilter: string;
  readonly onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={entry !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        {entry !== undefined && (
          <LogViewerBody key={entry.id} hostId={hostId} entry={entry} initialFilter={initialFilter} />
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LogViewerBody({
  hostId,
  entry,
  initialFilter,
}: {
  readonly hostId: string;
  readonly entry: SessionLogEntryWire;
  readonly initialFilter: string;
}) {
  const [text, setText] = useState<{ text: string; truncated: boolean } | { error: string } | undefined>(undefined);
  const [filter, setFilter] = useState(initialFilter);

  useEffect(() => {
    let current = true;
    void ipc()
      .sessionLog.read({ hostId, id: entry.id })
      .then((result) => {
        if (current) setText(result.ok ? result.value : { error: result.error.message });
      })
      .catch(() => {
        if (current) setText({ error: 'The log could not be read' });
      });
    return () => {
      current = false;
    };
  }, [hostId, entry.id]);

  const needle = filter.trim().toLowerCase();
  const lines = text !== undefined && 'text' in text ? text.text.split('\n') : [];
  const visible =
    needle === ''
      ? lines.map((line, i) => ({ line, number: i + 1 }))
      : lines.map((line, i) => ({ line, number: i + 1 })).filter((l) => l.line.toLowerCase().includes(needle));

  return (
    <Dialog.Content
      data-testid="session-log-viewer"
      className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[48rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-md bg-surface-raised p-4 shadow-lg"
    >
      <Dialog.Title className="text-md font-medium text-fg-default">
        {entry.hostName} · {when(entry.startedAt)}
      </Dialog.Title>
      <Dialog.Description className="text-xs text-fg-subtle">
        {entry.user}@{entry.address}:{String(entry.port)} · {ending(entry)} · {size(entry.bytes)}
        {text !== undefined && 'truncated' in text && text.truncated && ' · showing the end of a longer log'}
      </Dialog.Description>
      <input
        type="search"
        aria-label="Filter lines"
        placeholder="Show lines containing…"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
        className="h-7 rounded border border-hairline bg-surface-sunken px-2 text-sm text-fg-default"
      />
      {text === undefined ? (
        <p className="text-sm text-fg-subtle">Reading…</p>
      ) : 'error' in text ? (
        <p role="alert" className="text-sm text-status-danger">
          {text.error}
        </p>
      ) : (
        <pre
          data-testid="session-log-text"
          className="min-h-0 flex-1 overflow-auto rounded border border-hairline bg-surface-sunken p-2 font-mono text-xs whitespace-pre text-fg-default"
        >
          {needle === '' ? text.text : visible.map((l) => `${String(l.number).padStart(5)}  ${l.line}`).join('\n')}
        </pre>
      )}
      <div className="flex justify-end">
        <Dialog.Close className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base">Close</Dialog.Close>
      </div>
    </Dialog.Content>
  );
}
