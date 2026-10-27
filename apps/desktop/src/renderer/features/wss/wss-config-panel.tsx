/**
 * The right panel that edits one WS-Security configuration (#730): the sidebar keeps the list, the
 * configuration picked there opens here, with room for every label and the request still in front.
 */

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '../../components/button.js';
import { useProjectStore } from '../../state/project.js';
import { IncomingConfigForm } from './incoming-config-editor.js';
import { OutgoingConfigForm } from './outgoing-config-editor.js';
import { currentConfig, isWssConfigDirty, useWssConfigPanelStore } from './wss-config-panel-store.js';
import type { WssIncomingWire, WssOutgoingWire } from '@shared/kinds/soap/wire.js';

export function WssConfigPanel() {
  const editing = useWssConfigPanelStore((state) => state.editing);
  const original = useWssConfigPanelStore((state) => state.original);
  const asking = useWssConfigPanelStore((state) => state.asking);
  // Re-render on every change the configuration or its project's saved state goes through.
  useProjectStore((state) => state.wssOutgoing);
  useProjectStore((state) => state.wssIncoming);
  useProjectStore((state) => state.projects);
  const config = currentConfig(editing);
  if (editing === undefined || config === undefined) return null;
  const dirty = isWssConfigDirty(editing, original);
  const { answer, save } = useWssConfigPanelStore.getState();

  return (
    <div data-testid="wss-config-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-default">{config.name}</span>
        {dirty && (
          <span data-testid="wss-config-unsaved" className="shrink-0 text-xs text-status-warning">
            ● Unsaved
          </span>
        )}
        <Button
          data-testid="wss-config-save"
          disabled={!dirty}
          onClick={() => {
            void save();
          }}
        >
          Save
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-2">
        {editing.direction === 'outgoing' ? (
          <OutgoingConfigForm key={config.id} config={config as WssOutgoingWire & { readonly projectId: string }} />
        ) : (
          <IncomingConfigForm key={config.id} config={config as WssIncomingWire} />
        )}
      </div>

      <AlertDialog.Root
        open={asking}
        onOpenChange={(next) => {
          if (!next) void answer('cancel');
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
          <AlertDialog.Content
            data-testid="wss-config-unsaved-dialog"
            className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
          >
            <AlertDialog.Title className="text-md font-medium text-fg-default">
              Save changes to “{config.name}”?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              Don’t save puts the configuration back as it was when you opened it.
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <Button
                data-testid="wss-config-discard"
                onClick={() => {
                  void answer('discard');
                }}
              >
                Don’t save
              </Button>
              <Button
                variant="primary"
                data-testid="wss-config-save-and-close"
                onClick={() => {
                  void answer('save');
                }}
              >
                Save
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
