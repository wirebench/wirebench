import { useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { startForward } from './forward-actions.js';
import { useForwardsStore, type PortPrompt } from './forwards-store.js';

const FIELD_CLASS =
  'w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg';

/** A network bind's first start on this machine: Start retries with `confirmBind`, Cancel starts nothing. */
export function BindConfirmDialog() {
  const prompt = useForwardsStore((s) => s.bindPrompt);
  const setBindPrompt = useForwardsStore((s) => s.setBindPrompt);
  return (
    <ConfirmDialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) setBindPrompt(null);
      }}
      testId="forward-bind-dialog"
      title="Start on the network?"
      description={
        prompt === null
          ? ''
          : `${prompt.label} will be reachable from other machines at ${prompt.address}. You are asked once on this machine.`
      }
      confirmLabel="Start"
      onConfirm={() => {
        if (prompt === null) return;
        setBindPrompt(null);
        void startForward(prompt.hostId, prompt.ruleId, {
          confirmBind: true,
          ...(prompt.port === undefined ? {} : { port: prompt.port }),
        });
      }}
    />
  );
}

function PortForm({ prompt }: { readonly prompt: PortPrompt }) {
  const setPortPrompt = useForwardsStore((s) => s.setPortPrompt);
  const [value, setValue] = useState(String(prompt.suggested));
  const id = useId();
  const port = Number(value);
  const valid = /^\d+$/.test(value) && port >= 1 && port <= 65535;
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        setPortPrompt(null);
        void startForward(prompt.hostId, prompt.ruleId, { port });
      }}
    >
      <label htmlFor={id} className="flex flex-col gap-1 text-xs text-fg-subtle">
        Port
        <input
          id={id}
          autoFocus
          inputMode="numeric"
          className={FIELD_CLASS}
          value={value}
          onChange={(event) => {
            setValue(event.target.value.trim());
          }}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => {
            setPortPrompt(null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!valid}>
          Start
        </Button>
      </div>
    </form>
  );
}

/** "Start on another port…": this run only, the rule keeps its own port. */
export function PortDialog() {
  const prompt = useForwardsStore((s) => s.portPrompt);
  const setPortPrompt = useForwardsStore((s) => s.setPortPrompt);
  return (
    <Dialog.Root
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) setPortPrompt(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className={CONTENT_CLASS} data-testid="forward-port-dialog">
          <Dialog.Title className="text-md font-medium text-fg-default">Start on another port</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            {prompt === null ? '' : `${prompt.label} runs on this port until stopped; the rule keeps its own.`}
          </Dialog.Description>
          {prompt !== null && <PortForm key={`${prompt.hostId}/${prompt.ruleId}`} prompt={prompt} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The forwarding prompts, mounted once by the shell while the SSH area is on: any start can raise them. */
export function ForwardPrompts() {
  return (
    <>
      <BindConfirmDialog />
      <PortDialog />
    </>
  );
}
