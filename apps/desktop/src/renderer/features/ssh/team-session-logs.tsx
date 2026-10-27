import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import type { TeamSessionLogWire } from '@shared/session-log-wire.js';
import { hideTeamSessionLogs, showTeamSessionLogs, useTeamSessionLogsDialogStore } from './session-logs-store.js';

const SELECT_CLASS = 'h-7 rounded border border-hairline bg-surface-sunken px-1 text-sm text-fg-default';

function when(iso: string): string {
  return new Date(iso).toLocaleString();
}

function sizeOf(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The workspace server's SSH session logs (#430): every member's, newest first, filtered by host and member.
 * Opening one reads its text from the server, which records the read in its audit log; a log still being
 * written can be refreshed for what arrived since.
 */
export function TeamSessionLogsDialog() {
  const open = useTeamSessionLogsDialogStore((s) => s.open);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) showTeamSessionLogs();
        else hideTeamSessionLogs();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        {open && <TeamSessionLogsBody />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'ready'; readonly logs: readonly TeamSessionLogWire[]; readonly next: string | null };

function TeamSessionLogsBody() {
  const initialHost = useTeamSessionLogsDialogStore((s) => s.hostId);
  const [hostId, setHostId] = useState(initialHost ?? '');
  const [userId, setUserId] = useState('');
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const [known, setKnown] = useState<readonly TeamSessionLogWire[]>([]);
  const [opened, setOpened] = useState<TeamSessionLogWire | undefined>(undefined);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let current = true;
    setListing({ state: 'loading' });
    void ipc()
      .sessionLog.teamList({ ...(hostId ? { hostId } : {}), ...(userId ? { userId } : {}) })
      .then((result) => {
        if (!current) return;
        if (!result.ok) setListing({ state: 'failed', message: result.error.message });
        else if (!result.value.available) setListing({ state: 'unavailable' });
        else {
          setListing({ state: 'ready', logs: result.value.logs, next: result.value.next });
          // The filters offer every host and member seen so far, so narrowing one keeps the other's choices.
          setKnown((before) => [...before, ...result.value.logs.filter((l) => !before.some((b) => b.id === l.id))]);
        }
      })
      .catch(() => {
        if (current) setListing({ state: 'failed', message: 'The server could not be reached' });
      });
    return () => {
      current = false;
    };
  }, [hostId, userId, version]);

  const more = async (): Promise<void> => {
    if (listing.state !== 'ready' || listing.next === null) return;
    const result = await ipc().sessionLog.teamList({
      ...(hostId ? { hostId } : {}),
      ...(userId ? { userId } : {}),
      before: listing.next,
    });
    if (result.ok)
      setListing({ state: 'ready', logs: [...listing.logs, ...result.value.logs], next: result.value.next });
  };

  const hosts = [...new Map(known.map((l) => [l.hostId, l.hostName])).entries()];
  const members = [...new Map(known.map((l) => [l.userId, l.userName])).entries()];

  return (
    <Dialog.Content
      data-testid="team-session-logs-dialog"
      // An open log takes most of the window, so its text reads like a terminal's rather than in a small box (S42).
      className={`fixed top-1/2 left-1/2 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-md bg-surface-raised p-4 shadow-lg ${
        opened ? 'h-[85vh] w-[64rem]' : 'max-h-[85vh] w-[44rem]'
      }`}
    >
      <div className="flex items-start gap-2">
        <Dialog.Title className="flex-1 text-md font-medium text-fg-default">Team session logs</Dialog.Title>
        <Dialog.Close asChild>
          <button
            type="button"
            aria-label="Close"
            className="-m-1 rounded p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </Dialog.Close>
      </div>
      <Dialog.Description className="text-xs text-fg-subtle">
        What your team’s SSH sessions printed, as the server keeps it. Opening a log is recorded in the server’s audit
        log.
      </Dialog.Description>
      {opened ? (
        <TeamLogViewer
          log={opened}
          onBack={() => {
            setOpened(undefined);
          }}
        />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <select
              aria-label="Host"
              className={SELECT_CLASS}
              value={hostId}
              onChange={(event) => {
                setHostId(event.target.value);
              }}
            >
              <option value="">All hosts</option>
              {hosts.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Member"
              className={SELECT_CLASS}
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value);
              }}
            >
              <option value="">All members</option>
              {members.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={() => {
                setVersion((v) => v + 1);
              }}
            >
              Refresh
            </Button>
          </div>
          {listing.state === 'loading' && <p className="py-2 text-sm text-fg-subtle">Loading…</p>}
          {listing.state === 'unavailable' && (
            <p className="py-2 text-sm text-fg-subtle">
              This workspace is not shared to a Wirebench Server, so there are no team logs.
            </p>
          )}
          {listing.state === 'failed' && <p className="py-2 text-sm text-status-danger">{listing.message}</p>}
          {listing.state === 'ready' &&
            (listing.logs.length === 0 ? (
              <p className="py-2 text-sm text-fg-subtle">No session logs yet.</p>
            ) : (
              <ul aria-label="Team session logs" className="min-h-0 flex-1 overflow-auto">
                {listing.logs.map((log) => (
                  <li key={log.id}>
                    <button
                      type="button"
                      data-testid={`team-log-${log.id}`}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-fg-default hover:bg-surface-hover"
                      onClick={() => {
                        setOpened(log);
                      }}
                    >
                      {log.live && (
                        <span
                          aria-label="Still running"
                          title="Still running"
                          className="size-2 rounded-full bg-status-danger"
                        />
                      )}
                      <span className="truncate font-medium">{log.hostName}</span>
                      <span className="truncate text-fg-muted">{log.userName}</span>
                      <span className="ml-auto shrink-0 text-xs text-fg-subtle">
                        {when(log.startedAt)} · {sizeOf(log.size)}
                        {log.truncated ? ' · cut at the size limit' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          {listing.state === 'ready' && listing.next !== null && (
            <Button
              variant="ghost"
              onClick={() => {
                void more();
              }}
            >
              Older logs
            </Button>
          )}
        </>
      )}
    </Dialog.Content>
  );
}

/** One log's text, read in parts; Refresh reads what a running session wrote since. */
function TeamLogViewer({ log, onBack }: { readonly log: TeamSessionLogWire; readonly onBack: () => void }) {
  const [text, setText] = useState('');
  const [next, setNext] = useState(0);
  const [state, setState] = useState<{ size: number; live: boolean; error?: string }>({
    size: log.size,
    live: log.live,
  });
  const [loading, setLoading] = useState(false);
  // Whether the first part has come back: until then an empty text is not yet known to be empty.
  const [loaded, setLoaded] = useState(false);

  const read = async (from: number): Promise<void> => {
    setLoading(true);
    try {
      const result = await ipc().sessionLog.teamRead({ id: log.id, offset: from });
      if (!result.ok) {
        setState((s) => ({ ...s, error: result.error.message }));
        return;
      }
      setText((before) => (from === 0 ? result.value.text : before + result.value.text));
      setNext(result.value.next);
      setState({ size: result.value.size, live: result.value.live });
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void read(0);
    // Only on open: later parts are asked for.
  }, [log.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <span className="truncate font-medium text-fg-default">
          {log.hostName} · {log.userName}
        </span>
        <span className="truncate text-xs text-fg-subtle">{when(log.startedAt)}</span>
        {state.live && (
          <Button
            variant="ghost"
            className="ml-auto"
            disabled={loading}
            onClick={() => {
              void read(next);
            }}
          >
            Refresh
          </Button>
        )}
      </div>
      {state.error !== undefined && <p className="text-sm text-status-danger">{state.error}</p>}
      <pre
        data-testid="team-log-text"
        aria-label="Log text"
        className="min-h-48 flex-1 overflow-auto rounded border border-hairline bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-fg-default"
      >
        {text}
        {loaded && text === '' && state.error === undefined && (
          <span data-testid="team-log-empty" className="font-sans text-sm text-fg-subtle">
            {state.live
              ? 'Nothing recorded yet. Refresh reads what the session prints next.'
              : 'Nothing was recorded in this session.'}
          </span>
        )}
      </pre>
      {next < state.size && !state.live && (
        <Button
          variant="ghost"
          disabled={loading}
          onClick={() => {
            void read(next);
          }}
        >
          Read more
        </Button>
      )}
    </div>
  );
}
