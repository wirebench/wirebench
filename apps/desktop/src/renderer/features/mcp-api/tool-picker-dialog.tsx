/**
 * **New request from tool…** (#79): the tools the server's stored catalogue lists, to pick one from.
 * Picking makes a `tools/call` request named after the tool, with no arguments yet, and opens it.
 */
import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { useProjectStore } from '../../state/project.js';
import { newMcpRequestFromTool } from './mcp-api-actions.js';
import { useMcpToolPicker } from './tool-picker-state.js';

const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 flex max-h-[70vh] w-[32rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg';

/** Whether a tool matches the filter, by its name, title or description. */
export function toolMatches(
  tool: { readonly name: string; readonly title?: string | undefined; readonly description?: string | undefined },
  filter: string,
): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return true;
  return [tool.name, tool.title ?? '', tool.description ?? ''].some((text) => text.toLowerCase().includes(needle));
}

/** The picker. Mounted once, with the explorer. */
export function McpToolPickerDialog() {
  const apiId = useMcpToolPicker((state) => state.apiId);
  const close = useMcpToolPicker((state) => state.close);
  const server = useProjectStore((state) => (apiId === undefined ? undefined : state.mcpServers[apiId]));
  const [filter, setFilter] = useState('');
  const filterId = useId();
  useEffect(() => {
    if (apiId !== undefined) setFilter('');
  }, [apiId]);

  const tools = (server?.catalogue?.tools ?? []).filter((tool) => toolMatches(tool, filter));

  const pick = (tool: string): void => {
    if (apiId === undefined) return;
    close();
    newMcpRequestFromTool(apiId, tool);
  };

  return (
    <Dialog.Root
      open={apiId !== undefined}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className={CONTENT_CLASS} data-testid="mcp-tool-picker">
          <Dialog.Title className="text-md font-medium text-fg-default">New request from tool</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            The tools {server?.name ?? 'the server'} listed when its catalogue was last refreshed.
          </Dialog.Description>
          <label htmlFor={filterId} className="sr-only">
            Filter tools
          </label>
          <input
            id={filterId}
            autoFocus
            placeholder="Filter tools"
            data-testid="mcp-tool-picker-filter"
            className="mt-3 w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            onKeyDown={(event) => {
              const first = tools[0];
              if (event.key === 'Enter' && first !== undefined) {
                event.preventDefault();
                pick(first.name);
              }
            }}
          />
          <ul className="mt-2 min-h-0 flex-1 overflow-auto" aria-label="Tools">
            {tools.map((tool) => (
              <li key={tool.name}>
                <button
                  type="button"
                  data-testid="mcp-tool-picker-item"
                  className="flex w-full flex-col items-start rounded px-2 py-1 text-left hover:bg-surface-hover focus:bg-surface-hover focus:outline-none"
                  onClick={() => {
                    pick(tool.name);
                  }}
                >
                  <span className="font-mono text-sm text-fg-default">{tool.title ?? tool.name}</span>
                  {tool.description !== undefined && (
                    <span className="line-clamp-2 text-xs text-fg-subtle">{tool.description}</span>
                  )}
                </button>
              </li>
            ))}
            {tools.length === 0 && <li className="px-2 py-1 text-sm text-fg-subtle">No tool matches.</li>}
          </ul>
          <div className="mt-3 flex justify-end">
            <Button onClick={close}>Cancel</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
