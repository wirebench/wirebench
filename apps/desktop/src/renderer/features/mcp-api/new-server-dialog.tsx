/**
 * **New MCP server…** (#79): the name, the transport, and the command and its arguments or the URL.
 * Everything else (the environment, headers, auth, settings) is edited in the server's tab, which
 * opens once the server is made.
 */
import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { McpTransportWire } from '@shared/kinds/mcp/wire.js';
import { Button } from '../../components/button.js';
import { useProjectStore } from '../../state/project.js';
import { openMcpApiTab } from './mcp-api-actions.js';
import { useNewMcpServerDialog } from './new-server-dialog-state.js';

const FIELD_CLASS =
  'w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg';
const LABEL_CLASS = 'flex flex-col gap-1 text-xs text-fg-subtle';

export type McpTransportType = McpTransportWire['type'];

const TRANSPORTS: readonly { readonly type: McpTransportType; readonly label: string }[] = [
  { type: 'stdio', label: 'Local process (stdio)' },
  { type: 'http', label: 'Streamable HTTP' },
  { type: 'sse', label: 'HTTP+SSE (legacy)' },
];

/** What the form holds. Arguments are one per line, so an argument may hold spaces. */
export interface NewServerForm {
  readonly name: string;
  readonly type: McpTransportType;
  readonly command: string;
  readonly args: string;
  readonly url: string;
}

/** The transport the form describes, or why it cannot be made yet. */
export function transportOf(
  form: NewServerForm,
): { readonly transport: McpTransportWire } | { readonly problem: string } {
  if (form.type === 'stdio') {
    const command = form.command.trim();
    if (command === '') return { problem: 'Enter the command that starts the server' };
    const args = form.args
      .split('\n')
      .map((arg) => arg.trim())
      .filter((arg) => arg !== '');
    return { transport: { type: 'stdio', command, args, env: [] } };
  }
  const url = form.url.trim();
  if (url === '') return { problem: 'Enter the server’s URL' };
  return { transport: { type: form.type, url, headers: [] } };
}

/** The dialog. Mounted once, with the explorer. */
export function NewMcpServerDialog() {
  const projectId = useNewMcpServerDialog((state) => state.projectId);
  const suggestedName = useNewMcpServerDialog((state) => state.suggestedName);
  const close = useNewMcpServerDialog((state) => state.close);
  const open = projectId !== undefined;
  const [form, setForm] = useState<NewServerForm>({ name: '', type: 'stdio', command: '', args: '', url: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), command: useId(), args: useId(), url: useId() };

  useEffect(() => {
    if (!open) return;
    setForm({ name: suggestedName, type: 'stdio', command: '', args: '', url: '' });
    setError(undefined);
    setBusy(false);
  }, [open, suggestedName]);

  const change = (patch: Partial<NewServerForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setError(undefined);
  };

  const submit = (): void => {
    if (projectId === undefined || busy) return;
    const name = form.name.trim();
    if (name === '') {
      setError('Enter a name for the server');
      return;
    }
    const made = transportOf(form);
    if ('problem' in made) {
      setError(made.problem);
      return;
    }
    setBusy(true);
    useProjectStore
      .getState()
      .addMcpServer(projectId, name, made.transport)
      .then((apiId) => {
        close();
        openMcpApiTab(apiId);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'The server could not be created');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className={CONTENT_CLASS} data-testid="new-mcp-server-dialog">
          <Dialog.Title className="text-md font-medium text-fg-default">New MCP server</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            A local process this machine starts, or a server reached over HTTP.
          </Dialog.Description>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label htmlFor={ids.name} className={LABEL_CLASS}>
              Name
              <input
                id={ids.name}
                autoFocus
                data-testid="new-mcp-server-name"
                className={FIELD_CLASS}
                value={form.name}
                onChange={(event) => {
                  change({ name: event.target.value });
                }}
              />
            </label>
            <fieldset className="flex flex-col gap-1 text-xs text-fg-subtle">
              <legend className="mb-1">Transport</legend>
              {TRANSPORTS.map((transport) => (
                <label key={transport.type} className="flex items-center gap-2 text-sm text-fg-default">
                  <input
                    type="radio"
                    name="mcp-transport"
                    value={transport.type}
                    data-testid={`new-mcp-server-transport-${transport.type}`}
                    checked={form.type === transport.type}
                    onChange={() => {
                      change({ type: transport.type });
                    }}
                  />
                  {transport.label}
                </label>
              ))}
            </fieldset>
            {form.type === 'stdio' ? (
              <>
                <label htmlFor={ids.command} className={LABEL_CLASS}>
                  Command
                  <input
                    id={ids.command}
                    data-testid="new-mcp-server-command"
                    className={`${FIELD_CLASS} font-mono`}
                    placeholder="npx"
                    value={form.command}
                    onChange={(event) => {
                      change({ command: event.target.value });
                    }}
                  />
                </label>
                <label htmlFor={ids.args} className={LABEL_CLASS}>
                  Arguments, one per line
                  <textarea
                    id={ids.args}
                    data-testid="new-mcp-server-args"
                    rows={3}
                    className={`${FIELD_CLASS} font-mono`}
                    value={form.args}
                    onChange={(event) => {
                      change({ args: event.target.value });
                    }}
                  />
                </label>
                <p className="text-xs text-fg-subtle">
                  Wirebench asks before it first runs this command on this machine, and again whenever it changes.
                </p>
              </>
            ) : (
              <label htmlFor={ids.url} className={LABEL_CLASS}>
                {form.type === 'sse' ? 'Event stream URL' : 'URL'}
                <input
                  id={ids.url}
                  data-testid="new-mcp-server-url"
                  className={`${FIELD_CLASS} font-mono`}
                  placeholder="https://example.com/mcp"
                  value={form.url}
                  onChange={(event) => {
                    change({ url: event.target.value });
                  }}
                />
              </label>
            )}
            {error !== undefined && (
              <p role="alert" className="text-sm text-status-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={busy} data-testid="new-mcp-server-create">
                Create
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
