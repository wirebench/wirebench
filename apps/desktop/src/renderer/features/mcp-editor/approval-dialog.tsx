/**
 * The stdio approval prompt (#79). A send or a catalogue refresh that would start a command line
 * this machine has not approved waits in main, which asks through `mcp.approval`; this dialog shows
 * what would run and answers with `app.mcpApprove`: *Run once*, *Always allow* or *Cancel*.
 * Dismissing it is *Cancel*, so the send never hangs on a dialog closed with Escape.
 *
 * Mounted once by the shell, not by the editor, so a run or a refresh started from anywhere is
 * answered. Prompts that arrive while one is shown wait their turn. Main masks the command line's
 * secrets before it sends it, and sends the variables' names only, never their values.
 *
 * Eagerly loaded, so it imports the wire module for its types only (the renderer CSP trap).
 */
import { useEffect, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import type { McpApprovalAnswerWire, McpApprovalPromptEvent } from '../../../shared/kinds/mcp/wire.js';

/** The approval dialog: shows the oldest prompt waiting, one at a time. */
export function McpApprovalDialog() {
  const [queue, setQueue] = useState<readonly McpApprovalPromptEvent[]>([]);

  useEffect(
    () =>
      window.wirebench.on('mcp.approval', ((payload: McpApprovalPromptEvent) => {
        setQueue((waiting) =>
          waiting.some((prompt) => prompt.promptId === payload.promptId) ? waiting : [...waiting, payload],
        );
      }) as (payload: unknown) => void),
    [],
  );

  const prompt = queue[0];

  const answer = (answer: McpApprovalAnswerWire): void => {
    if (prompt === undefined) return;
    setQueue((waiting) => waiting.filter((entry) => entry.promptId !== prompt.promptId));
    // Main ignores an answer to a prompt it no longer holds, so there is nothing to report back.
    void ipc()
      .app.mcpApprove({ promptId: prompt.promptId, answer })
      .catch(() => undefined);
  };

  return (
    <AlertDialog.Root
      open={prompt !== undefined}
      onOpenChange={(open) => {
        if (!open) answer('cancel');
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          data-testid="mcp-approval-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <AlertDialog.Title className="text-md font-medium text-fg-default">Run this command?</AlertDialog.Title>
          {prompt !== undefined && (
            <AlertDialog.Description asChild>
              <div className="mt-1 flex min-h-0 flex-col gap-3 overflow-y-auto text-sm text-fg-subtle">
                <p>
                  <span data-testid="mcp-approval-server" className="font-medium text-fg-default">
                    {prompt.serverName}
                  </span>{' '}
                  starts a local process on this machine. Run it only if you trust the project it came from.
                </p>
                <div>
                  <div className="text-xs">Command</div>
                  <code
                    data-testid="mcp-approval-command"
                    className="block font-mono text-xs break-all whitespace-pre-wrap text-fg-default"
                  >
                    {prompt.display}
                  </code>
                </div>
                <div>
                  <div className="text-xs">Folder</div>
                  <code data-testid="mcp-approval-cwd" className="block font-mono text-xs break-all text-fg-default">
                    {prompt.cwd}
                  </code>
                </div>
                <div>
                  <div className="text-xs">Environment variables</div>
                  {prompt.envNames.length === 0 ? (
                    <p data-testid="mcp-approval-env-none" className="text-xs">
                      None.
                    </p>
                  ) : (
                    <ul data-testid="mcp-approval-env" className="flex flex-wrap gap-1">
                      {prompt.envNames.map((name) => (
                        <li key={name} className="rounded bg-surface-base px-1.5 font-mono text-xs text-fg-default">
                          {name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="text-xs">
                  Always allow remembers this exact command line on this machine. A change to the command, an argument,
                  the folder or the set of variables asks again.
                </p>
              </div>
            </AlertDialog.Description>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              data-testid="mcp-approval-cancel"
              onClick={() => {
                answer('cancel');
              }}
            >
              Cancel
            </Button>
            <Button
              data-testid="mcp-approval-always"
              onClick={() => {
                answer('always');
              }}
            >
              Always allow
            </Button>
            <Button
              variant="primary"
              data-testid="mcp-approval-once"
              onClick={() => {
                answer('once');
              }}
            >
              Run once
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
