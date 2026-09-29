/**
 * A catch URL's settings (webhook-capture spec §4.2): its name, whether it answers, and the fixed
 * response every sender gets. Create and edit share it; a viewer sees it read only.
 * Editing an existing catch URL also shows its Signature section (webhook-signatures §4).
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { useSyncStore } from '../../state/sync.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { INPUT_CLASS } from '../team/roles.js';
import { SignatureSection, signatureFormOf, signatureProblemOf, signatureRequestOf } from './catch-url-signature.js';
import type { SignatureForm } from './catch-url-signature.js';
import { CATCH_URL_LIMITS, PRINTABLE_ASCII } from './limits.js';
import { openCatchUrlTab } from './webhooks-actions.js';
import { useWebhooksDialogs } from './webhooks-dialogs-state.js';
import type { CatchUrlResponseWire, CatchUrlWire } from '../../../shared/wire-types.js';

export interface CatchUrlForm {
  readonly name: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly contentType: string;
  readonly body: string;
  readonly delayMs: string;
}

const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';

export function formOf(hook: CatchUrlWire | undefined): CatchUrlForm {
  return {
    name: hook?.name ?? '',
    enabled: hook?.enabled ?? true,
    status: String(hook?.response.status ?? 200),
    contentType: hook?.response.contentType ?? '',
    body: hook?.response.body ?? '',
    delayMs: String(hook?.response.delayMs ?? 0),
  };
}

const whole = (text: string, min: number, max: number): boolean =>
  /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The first thing the server would refuse, in the words the dialog shows; `undefined` when none. */
export function problemOf(form: CatchUrlForm): string | undefined {
  const name = form.name.trim();
  if (name.length === 0) return 'Give the catch URL a name.';
  if (name.length > CATCH_URL_LIMITS.maxNameLength)
    return `Names are at most ${CATCH_URL_LIMITS.maxNameLength} characters.`;
  if (!whole(form.status, CATCH_URL_LIMITS.minStatus, CATCH_URL_LIMITS.maxStatus))
    return `Status is a number from ${CATCH_URL_LIMITS.minStatus} to ${CATCH_URL_LIMITS.maxStatus}.`;
  if (!whole(form.delayMs, 0, CATCH_URL_LIMITS.maxDelayMs))
    return `The delay is 0 to ${CATCH_URL_LIMITS.maxDelayMs} ms.`;
  if (
    form.contentType !== '' &&
    (!PRINTABLE_ASCII.test(form.contentType) || form.contentType.length > CATCH_URL_LIMITS.maxContentTypeLength)
  )
    return `The content type is up to ${CATCH_URL_LIMITS.maxContentTypeLength} printable ASCII characters.`;
  if (new TextEncoder().encode(form.body).length > CATCH_URL_LIMITS.maxResponseBodyBytes)
    return 'The body is at most 64 KiB.';
  return undefined;
}

export function requestOf(form: CatchUrlForm): {
  readonly name: string;
  readonly enabled: boolean;
  readonly response: CatchUrlResponseWire;
} {
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    response: {
      status: Number(form.status),
      contentType: form.contentType === '' ? null : form.contentType,
      body: form.body === '' ? null : form.body,
      delayMs: Number(form.delayMs),
    },
  };
}

export function CatchUrlSettingsDialog() {
  const settings = useWebhooksDialogs((state) => state.settings);
  const close = useWebhooksDialogs((state) => state.closeSettings);
  const role = useSyncStore((state) => state.status.role);
  const readOnly = role !== 'editor' && role !== 'admin';
  const [form, setForm] = useState<CatchUrlForm>(() => formOf(undefined));
  const [signature, setSignature] = useState<SignatureForm>(() => signatureFormOf(undefined));
  const [hook, setHook] = useState<CatchUrlWire | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const hookId = settings?.hookId;

  // Filled once per opening: a list refresh while the dialog is open must not undo the user's typing.
  useEffect(() => {
    if (settings === undefined) return;
    const hook =
      settings.hookId === undefined
        ? undefined
        : useWebhooksStore.getState().hooks.find((candidate) => candidate.id === settings.hookId);
    setForm(formOf(hook));
    setSignature(signatureFormOf(hook));
    setHook(hook);
    setRefused(undefined);
  }, [settings]);

  const problem = problemOf(form) ?? (hookId === undefined ? undefined : signatureProblemOf(signature, hook));
  const edit = (patch: Partial<CatchUrlForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setRefused(undefined);
  };

  const editSignature = (patch: Partial<SignatureForm>): void => {
    setSignature((current) => ({ ...current, ...patch }));
    setRefused(undefined);
  };

  const save = async (): Promise<void> => {
    const server = useWebhooksStore.getState().server;
    if (server === undefined || problem !== undefined) return;
    setBusy(true);
    const request = requestOf(form);
    const result =
      hookId === undefined
        ? await ipc().hooks.create({ ...server, ...request })
        : await ipc().hooks.update({ ...server, hookId, ...request, ...signatureRequestOf(signature, hook) });
    setBusy(false);
    if (!result.ok) {
      setRefused(result.error.message);
      return;
    }
    close();
    await useWebhooksStore.getState().refresh();
    if (hookId === undefined) openCatchUrlTab(result.value.hook.id);
  };

  const shownProblem = refused ?? (form.name === '' ? undefined : problem);
  return (
    <Dialog.Root
      open={settings !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="catch-url-settings"
          className="fixed top-1/2 left-1/2 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">
            {hookId === undefined ? 'New catch URL' : 'Catch URL settings'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {readOnly
              ? 'Only editors can change a catch URL.'
              : 'Every request to the URL is captured and answered with this response.'}
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className={LABEL_CLASS} htmlFor="catch-url-name">
              Name
            </label>
            <input
              id="catch-url-name"
              data-testid="catch-url-name"
              autoFocus
              disabled={readOnly}
              value={form.name}
              onChange={(event) => edit({ name: event.target.value })}
              className={INPUT_CLASS}
            />
            <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
              <input
                type="checkbox"
                data-testid="catch-url-enabled"
                disabled={readOnly}
                checked={form.enabled}
                onChange={(event) => edit({ enabled: event.target.checked })}
              />
              Enabled (a disabled catch URL answers 404 and stores nothing)
            </label>
            <div className="flex gap-3">
              <div className="w-28">
                <label className={LABEL_CLASS} htmlFor="catch-url-status">
                  Status
                </label>
                <input
                  id="catch-url-status"
                  data-testid="catch-url-status"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={form.status}
                  onChange={(event) => edit({ status: event.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div className="min-w-0 flex-1">
                <label className={LABEL_CLASS} htmlFor="catch-url-content-type">
                  Content type
                </label>
                <input
                  id="catch-url-content-type"
                  data-testid="catch-url-content-type"
                  placeholder="None"
                  disabled={readOnly}
                  value={form.contentType}
                  onChange={(event) => edit({ contentType: event.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div className="w-32">
                <label className={LABEL_CLASS} htmlFor="catch-url-delay">
                  Delay (ms)
                </label>
                <input
                  id="catch-url-delay"
                  data-testid="catch-url-delay"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={form.delayMs}
                  onChange={(event) => edit({ delayMs: event.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <label className={LABEL_CLASS} htmlFor="catch-url-body">
              Body
            </label>
            <textarea
              id="catch-url-body"
              data-testid="catch-url-body"
              rows={6}
              placeholder="None"
              disabled={readOnly}
              value={form.body}
              onChange={(event) => edit({ body: event.target.value })}
              className={`${INPUT_CLASS} font-mono`}
            />
            {hookId !== undefined && hook?.signatureAvailable !== undefined && (
              <SignatureSection form={signature} onChange={editSignature} hook={hook} readOnly={readOnly} />
            )}
            {shownProblem !== undefined && (
              <p role="alert" data-testid="catch-url-settings-problem" className="mt-2 text-sm text-status-danger">
                {shownProblem}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>{readOnly ? 'Close' : 'Cancel'}</Button>
              </Dialog.Close>
              {!readOnly && (
                <Button
                  type="submit"
                  data-testid="catch-url-save"
                  variant="primary"
                  disabled={busy || problem !== undefined}
                >
                  {hookId === undefined ? 'Create' : 'Save'}
                </Button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
