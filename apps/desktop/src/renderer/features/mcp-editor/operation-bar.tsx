/**
 * The MCP request's top strip (#79): Send (Cancel while the session runs), the operation's method,
 * and what it names: the tool or prompt, picked from the server's catalogue or typed, or the
 * resource's URI. A list method names nothing.
 */
import { Send, Square } from 'lucide-react';
import { Button } from '../../components/button.js';
import type { McpCatalogueWire, McpMethodWire, McpOperationWire } from '../../../shared/kinds/mcp/wire.js';

/** Every method a request can run, in the order the picker lists them. */
export const MCP_METHODS: readonly McpMethodWire[] = [
  'tools/call',
  'resources/read',
  'prompts/get',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
];

/**
 * The operation `method` makes of `current`. The same method keeps it whole; another starts its
 * own fields blank, since a tool's name is no prompt's and a call's arguments are no prompt's.
 */
export function switchMethod(current: McpOperationWire, method: McpMethodWire): McpOperationWire {
  if (current.method === method) return current;
  switch (method) {
    case 'tools/call':
      return { method, tool: '', arguments: '' };
    case 'resources/read':
      return { method, uri: '' };
    case 'prompts/get':
      return { method, prompt: '', arguments: [] };
    default:
      return { method };
  }
}

const FIELD_CLASS =
  'h-row rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none';

export interface OperationBarProps {
  readonly operation: McpOperationWire;
  /** The server's catalogue of its last refresh; absent before the first. */
  readonly catalogue: McpCatalogueWire | undefined;
  readonly sending: boolean;
  readonly onChange: (operation: McpOperationWire) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly sendShortcut?: string | undefined;
}

/** A text field with the catalogue's names offered beside it; anything typed is kept. */
function NamedField({
  label,
  testId,
  value,
  placeholder,
  options,
  onChange,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string;
  readonly placeholder: string;
  readonly options: readonly { readonly value: string; readonly hint?: string | undefined }[];
  readonly onChange: (value: string) => void;
}) {
  const listId = `${testId}-options`;
  return (
    <>
      <input
        aria-label={label}
        data-testid={testId}
        spellCheck={false}
        list={listId}
        value={value}
        placeholder={placeholder}
        className={`${FIELD_CLASS} min-w-0 flex-1`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <datalist id={listId} data-testid={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.hint}
          </option>
        ))}
      </datalist>
    </>
  );
}

/** The Send, method and target strip. */
export function OperationBar({
  operation,
  catalogue,
  sending,
  onChange,
  onSend,
  onCancel,
  sendShortcut,
}: OperationBarProps) {
  return (
    <div className="flex h-title-bar shrink-0 items-center gap-2 border-b border-hairline bg-surface-base px-3">
      {sending ? (
        <Button variant="secondary" data-testid="mcp-send" onClick={onCancel} title="Cancel (Esc)">
          <Square size={12} aria-hidden="true" />
          Cancel
        </Button>
      ) : (
        <Button
          variant="primary"
          data-testid="mcp-send"
          onClick={onSend}
          {...(sendShortcut !== undefined ? { title: `Send (${sendShortcut})` } : {})}
        >
          <Send size={12} aria-hidden="true" />
          Send
        </Button>
      )}

      <select
        aria-label="Method"
        data-testid="mcp-method"
        value={operation.method}
        className={`${FIELD_CLASS} w-52 shrink-0`}
        onChange={(event) => {
          onChange(switchMethod(operation, event.target.value as McpMethodWire));
        }}
      >
        {MCP_METHODS.map((method) => (
          <option key={method} value={method}>
            {method}
          </option>
        ))}
      </select>

      {operation.method === 'tools/call' && (
        <NamedField
          label="Tool"
          testId="mcp-tool"
          value={operation.tool}
          placeholder="Tool name"
          options={(catalogue?.tools ?? []).map((tool) => ({ value: tool.name, hint: tool.title ?? tool.description }))}
          onChange={(tool) => {
            onChange({ ...operation, tool });
          }}
        />
      )}
      {operation.method === 'prompts/get' && (
        <NamedField
          label="Prompt"
          testId="mcp-prompt"
          value={operation.prompt}
          placeholder="Prompt name"
          options={(catalogue?.prompts ?? []).map((prompt) => ({
            value: prompt.name,
            hint: prompt.title ?? prompt.description,
          }))}
          onChange={(prompt) => {
            onChange({ ...operation, prompt });
          }}
        />
      )}
      {operation.method === 'resources/read' && (
        <NamedField
          label="Resource URI"
          testId="mcp-uri"
          value={operation.uri}
          placeholder="file:///path or a template's expansion"
          options={(catalogue?.resources ?? []).map((resource) => ({
            value: resource.uri,
            hint: resource.title ?? resource.name,
          }))}
          onChange={(uri) => {
            onChange({ ...operation, uri });
          }}
        />
      )}
      {operation.method.endsWith('/list') && (
        <span data-testid="mcp-list-hint" className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
          Asks the server for its list; this method takes no arguments.
        </span>
      )}
    </div>
  );
}
