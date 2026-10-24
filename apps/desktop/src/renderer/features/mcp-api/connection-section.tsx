/**
 * The Connection section of an MCP server's tab (#79): how a session reaches the server.
 *
 * A stdio server is a command, its arguments, the folder it runs in and its environment; an HTTP or
 * SSE server is a URL, the headers every call sends and the credentials. Every edit hands the whole
 * next transport up, since the patch replaces `transport` whole. Switching between HTTP and SSE keeps
 * the URL, headers and auth (the same fields); switching to or from stdio starts the other side blank.
 */
import { useId } from 'react';
import { Trash2 } from 'lucide-react';
import { AuthFields } from '../../components/auth-fields.js';
import { IconButton } from '../../components/icon-button.js';
import { KV_INPUT_CLASS, KvTable, useCommittedDraft } from '../../components/kv-table.js';
import { EnumSetting, SettingsGroup, SettingsRow, TextSetting } from '../../components/settings-grid.js';
import { OAuth2StatusPanel } from '../rest-editor/oauth2-status.js';
import type { AuthConfigWire } from '../../../shared/wire-base.js';
import type { McpTransportWire } from '../../../shared/kinds/mcp/wire.js';

type TransportType = McpTransportWire['type'];
type HttpTransport = Extract<McpTransportWire, { readonly type: 'http' | 'sse' }>;

const TRANSPORT_OPTIONS = [
  { value: 'stdio', label: 'stdio' },
  { value: 'http', label: 'Streamable HTTP' },
  { value: 'sse', label: 'HTTP+SSE' },
] as const;

/** The transport after picking `type`: the fields the two HTTP transports share carry over. */
export function switchTransport(current: McpTransportWire, type: TransportType): McpTransportWire {
  if (type === current.type) return current;
  if (type === 'stdio') return { type: 'stdio', command: '', args: [], env: [] };
  if (current.type === 'stdio') return { type, url: '', headers: [] };
  return { ...current, type };
}

export interface ConnectionSectionProps {
  readonly apiId: string;
  readonly transport: McpTransportWire;
  readonly onChange: (transport: McpTransportWire) => void;
}

export function ConnectionSection({ apiId, transport, onChange }: ConnectionSectionProps) {
  return (
    <>
      <SettingsGroup hint="How a session reaches the server.">
        <EnumSetting
          label="Transport"
          testId="mcp-api-transport"
          display="select"
          value={transport.type}
          options={TRANSPORT_OPTIONS}
          onChange={(type) => {
            onChange(switchTransport(transport, type as TransportType));
          }}
        />
        {transport.type === 'stdio' ? (
          <>
            <TextSetting
              label="Command"
              testId="mcp-api-command"
              monospace
              placeholder="npx"
              hint="Run with no shell: the program itself, not a command line."
              value={transport.command}
              onCommit={(command) => {
                onChange({ ...transport, command });
              }}
            />
            <ArgumentsRow
              args={transport.args}
              onChange={(args) => {
                onChange({ ...transport, args });
              }}
            />
            <TextSetting
              label="Folder"
              testId="mcp-api-cwd"
              monospace
              placeholder="The project folder"
              hint="Relative to the project folder."
              value={transport.cwd ?? ''}
              onCommit={(cwd) => {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
                const { cwd: _dropped, ...rest } = transport;
                onChange(cwd === '' ? rest : { ...rest, cwd });
              }}
            />
          </>
        ) : (
          <TextSetting
            label="URL"
            testId="mcp-api-url"
            monospace
            placeholder={transport.type === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'}
            {...(transport.type === 'sse' ? { hint: 'The event-stream endpoint.' } : {})}
            value={transport.url}
            onCommit={(url) => {
              onChange({ ...transport, url });
            }}
          />
        )}
      </SettingsGroup>

      {transport.type === 'stdio' ? (
        <SettingsGroup title="Environment" hint="Variables the server starts with, on top of this machine’s.">
          <KvTable
            label="Server environment"
            testidPrefix="mcp-api-env"
            rows={transport.env}
            columns={['enabled', 'name', 'value', 'description']}
            placeholders={{ name: 'NAME', value: 'value' }}
            emptyMessage="No variables."
            onChange={(env) => {
              onChange({ ...transport, env: [...env] });
            }}
          />
        </SettingsGroup>
      ) : (
        <HttpFields apiId={apiId} transport={transport} onChange={onChange} />
      )}
    </>
  );
}

/** The headers and credentials of an HTTP or SSE server. */
function HttpFields({
  apiId,
  transport,
  onChange,
}: {
  readonly apiId: string;
  readonly transport: HttpTransport;
  readonly onChange: (transport: McpTransportWire) => void;
}) {
  return (
    <>
      <SettingsGroup title="Headers" hint="Sent with every HTTP call of a session.">
        <KvTable
          label="Server headers"
          testidPrefix="mcp-api-headers"
          rows={transport.headers}
          columns={['enabled', 'name', 'value', 'description']}
          placeholders={{ name: 'key', value: 'value' }}
          emptyMessage="No headers."
          onChange={(headers) => {
            onChange({ ...transport, headers: [...headers] });
          }}
        />
      </SettingsGroup>
      <SettingsGroup title="Authentication" hint="Applied to every HTTP call of a session.">
        <AuthFields
          scope="Server"
          auth={transport.auth === undefined || transport.auth.type === 'inherit' ? undefined : transport.auth}
          onChange={(auth: AuthConfigWire | null) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { auth: _dropped, ...rest } = transport;
            onChange(auth === null ? rest : { ...rest, auth });
          }}
          oauth2Status={
            transport.auth?.type === 'oauth2' ? (
              <OAuth2StatusPanel ownerId={apiId} grant={transport.auth.grant} />
            ) : undefined
          }
        />
      </SettingsGroup>
    </>
  );
}

/**
 * The arguments, one per line of the list: each is passed to the command as it is, so a value with
 * spaces needs no quoting. The empty field at the bottom appends one.
 */
function ArgumentsRow({
  args,
  onChange,
}: {
  readonly args: readonly string[];
  readonly onChange: (args: string[]) => void;
}) {
  const newId = useId();
  return (
    <SettingsRow label="Arguments" htmlFor={newId} hint="Passed to the command one by one, unquoted.">
      <ul aria-label="Arguments" data-testid="mcp-api-args" className="flex flex-col">
        {args.map((arg, index) => (
          // Arguments are positional and may repeat, so the position is their identity.
          <li key={index} className="flex items-center gap-1">
            <ArgumentField
              label={`Argument ${String(index + 1)}`}
              testId={`mcp-api-arg-${String(index)}`}
              value={arg}
              onCommit={(next) => {
                onChange(args.map((candidate, at) => (at === index ? next : candidate)));
              }}
            />
            <IconButton
              label={`Remove argument ${String(index + 1)}`}
              data-testid={`mcp-api-arg-remove-${String(index)}`}
              onClick={() => {
                onChange(args.filter((_, at) => at !== index));
              }}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </IconButton>
          </li>
        ))}
        <li className="flex items-center gap-1">
          <ArgumentField
            // A fresh field once an argument is appended, so the one just typed does not linger.
            key={args.length}
            id={newId}
            label="New argument"
            testId="mcp-api-arg-new"
            placeholder="argument"
            value=""
            onCommit={(next) => {
              if (next !== '') onChange([...args, next]);
            }}
          />
        </li>
      </ul>
    </SettingsRow>
  );
}

function ArgumentField({
  id,
  label,
  testId,
  value,
  placeholder,
  onCommit,
}: {
  readonly id?: string;
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onCommit: (value: string) => void;
}) {
  const field = useCommittedDraft(value, onCommit);
  return (
    <input
      {...(id === undefined ? {} : { id })}
      aria-label={label}
      data-testid={testId}
      {...(placeholder === undefined ? {} : { placeholder })}
      className={KV_INPUT_CLASS}
      {...field}
    />
  );
}
