/**
 * *Import webhooks…*: the picker that reads an OpenAPI-imported API's webhooks and callbacks
 * (`api.webhookItems`) and places the chosen ones into the project's linked webhook group
 * (`api.importWebhooks`). What matters here is that an already-imported row cannot be unticked,
 * that only the ticked-and-not-yet-imported keys are sent, and the `webhook-definition-missing`
 * dead end offers nothing but Close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportWebhooksDialog } from '../../src/renderer/features/webhook-items/import-webhooks-dialog.js';
import { useWebhookItemsDialogs } from '../../src/renderer/features/webhook-items/webhook-items-state.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const ITEMS = [
  {
    key: 'webhook newPet post',
    kind: 'webhook' as const,
    name: 'newPet',
    method: 'post',
    label: 'webhook newPet POST',
  },
  {
    key: 'callback subEvent post',
    kind: 'callback' as const,
    name: 'subEvent',
    method: 'post',
    label: 'callback subEvent POST',
  },
];

beforeEach(() => {
  showToast.mockReset();
  useWebhookItemsDialogs.getState().close();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ImportWebhooksDialog', () => {
  it('renders nothing when no import is requested', () => {
    installWirebenchApi();
    render(<ImportWebhooksDialog />);
    expect(screen.queryByTestId('import-webhooks-dialog')).toBeNull();
  });

  it('lists every item ticked, sends the ticked keys, closes and toasts the count', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: true, value: { items: ITEMS, imported: [] } });
    const importWebhooks = vi.fn().mockResolvedValue({ ok: true, value: { folderId: 'folder-1', added: 2 } });
    installWirebenchApi({ api: { webhookItems, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    await waitFor(() => expect(webhookItems).toHaveBeenCalledWith({ apiId: 'api-1' }));
    const first = await screen.findByLabelText<HTMLInputElement>('webhook newPet POST');
    const second = screen.getByLabelText<HTMLInputElement>('callback subEvent POST');
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(true);

    fireEvent.click(screen.getByTestId('import-webhooks-submit'));
    await waitFor(() => expect(importWebhooks).toHaveBeenCalled());
    expect(importWebhooks).toHaveBeenCalledWith({
      apiId: 'api-1',
      keys: ['webhook newPet post', 'callback subEvent post'],
    });
    expect(showToast).toHaveBeenCalledWith('Imported 2 webhooks');
    expect(useWebhookItemsDialogs.getState().importFor).toBeUndefined();
  });

  it('reads naturally for a single webhook', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: true, value: { items: [ITEMS[0]!], imported: [] } });
    const importWebhooks = vi.fn().mockResolvedValue({ ok: true, value: { folderId: 'folder-1', added: 1 } });
    installWirebenchApi({ api: { webhookItems, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    fireEvent.click(await screen.findByTestId('import-webhooks-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Imported 1 webhook'));
  });

  it('shows an already-imported row ticked and disabled, and leaves its key out of the send', async () => {
    const webhookItems = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { items: ITEMS, imported: ['webhook newPet post'] } });
    const importWebhooks = vi.fn().mockResolvedValue({ ok: true, value: { folderId: 'folder-1', added: 1 } });
    installWirebenchApi({ api: { webhookItems, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    const already = await screen.findByLabelText<HTMLInputElement>('webhook newPet POST');
    expect(already.checked).toBe(true);
    expect(already.disabled).toBe(true);
    expect(screen.getByTestId('import-webhooks-row-webhook newPet post').textContent).toContain('already imported');

    fireEvent.click(screen.getByTestId('import-webhooks-submit'));
    await waitFor(() =>
      expect(importWebhooks).toHaveBeenCalledWith({ apiId: 'api-1', keys: ['callback subEvent post'] }),
    );
  });

  it('unticks and reticks one row without disturbing the other', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: true, value: { items: ITEMS, imported: [] } });
    const importWebhooks = vi.fn().mockResolvedValue({ ok: true, value: { folderId: 'folder-1', added: 1 } });
    installWirebenchApi({ api: { webhookItems, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    const first = await screen.findByLabelText<HTMLInputElement>('webhook newPet POST');
    fireEvent.click(first);
    expect(first.checked).toBe(false);
    fireEvent.click(screen.getByTestId('import-webhooks-submit'));
    await waitFor(() =>
      expect(importWebhooks).toHaveBeenCalledWith({ apiId: 'api-1', keys: ['callback subEvent post'] }),
    );
  });

  it('the all toggle unticks and reticks every selectable row', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: true, value: { items: ITEMS, imported: [] } });
    installWirebenchApi({ api: { webhookItems } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    await screen.findByLabelText<HTMLInputElement>('webhook newPet POST');
    const all = screen.getByTestId<HTMLInputElement>('import-webhooks-all');
    expect(all.checked).toBe(true);

    fireEvent.click(all);
    expect(screen.getByLabelText<HTMLInputElement>('webhook newPet POST').checked).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('callback subEvent POST').checked).toBe(false);

    fireEvent.click(all);
    expect(screen.getByLabelText<HTMLInputElement>('webhook newPet POST').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('callback subEvent POST').checked).toBe(true);
  });

  it('closes without calling the channel when nothing is left ticked', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: true, value: { items: ITEMS, imported: [] } });
    const importWebhooks = vi.fn();
    installWirebenchApi({ api: { webhookItems, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    fireEvent.click(await screen.findByLabelText('webhook newPet POST'));
    fireEvent.click(screen.getByLabelText('callback subEvent POST'));
    fireEvent.click(screen.getByTestId('import-webhooks-submit'));

    await waitFor(() => expect(useWebhookItemsDialogs.getState().importFor).toBeUndefined());
    expect(importWebhooks).not.toHaveBeenCalled();
  });

  it('shows the dead-end message and only Close when the API has no stored definition', async () => {
    const webhookItems = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'webhook-definition-missing', message: 'no definition' } });
    installWirebenchApi({ api: { webhookItems } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    expect((await screen.findByTestId('import-webhooks-missing')).textContent).toBe(
      'This API has no stored definition to read webhooks from.',
    );
    expect(screen.queryByTestId('import-webhooks-submit')).toBeNull();
    expect(screen.queryByTestId('import-webhooks-cancel')).toBeNull();

    fireEvent.click(screen.getByTestId('import-webhooks-close'));
    expect(useWebhookItemsDialogs.getState().importFor).toBeUndefined();
  });

  it('shows another error as-is, distinct from the definition-missing dead end', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: false, error: { code: 'other', message: 'boom' } });
    installWirebenchApi({ api: { webhookItems } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    expect((await screen.findByTestId('import-webhooks-error')).textContent).toBe('boom');
    expect(screen.queryByTestId('import-webhooks-missing')).toBeNull();
  });

  it('reports an error from the import call itself', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: true, value: { items: ITEMS, imported: [] } });
    const importWebhooks = vi.fn().mockResolvedValue({ ok: false, error: { code: 'other', message: 'save failed' } });
    installWirebenchApi({ api: { webhookItems, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');

    fireEvent.click(await screen.findByTestId('import-webhooks-submit'));
    expect((await screen.findByTestId('import-webhooks-error')).textContent).toBe('save failed');
    // Nothing closed: the picker stays open so the user can try again.
    expect(useWebhookItemsDialogs.getState().importFor).toEqual({ apiId: 'api-1' });
  });

  it('shows an error and re-enables Import when the import call itself rejects', async () => {
    const webhookItems = vi.fn().mockResolvedValue({ ok: true, value: { items: ITEMS, imported: [] } });
    const importWebhooks = vi.fn().mockRejectedValue(new Error('bridge is gone'));
    installWirebenchApi({ api: { webhookItems, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');
    await screen.findByLabelText('webhook newPet POST');

    const submit = screen.getByTestId<HTMLButtonElement>('import-webhooks-submit');
    fireEvent.click(submit);
    expect(submit.disabled).toBe(true);

    expect((await screen.findByTestId('import-webhooks-error')).textContent).toBe('bridge is gone');
    await waitFor(() => expect(submit.disabled).toBe(false));
    // Nothing closed: the picker stays open so the user can try again.
    expect(useWebhookItemsDialogs.getState().importFor).toEqual({ apiId: 'api-1' });
  });

  it('drops a reply that lands after the dialog closed and reopened for another API', async () => {
    let resolveImport: (value: unknown) => void = () => undefined;
    const webhookItemsA = vi.fn().mockResolvedValue({ ok: true, value: { items: ITEMS, imported: [] } });
    const importWebhooks = vi.fn().mockReturnValue(new Promise((resolve) => (resolveImport = resolve)));
    installWirebenchApi({ api: { webhookItems: webhookItemsA, importWebhooks } });
    render(<ImportWebhooksDialog />);
    useWebhookItemsDialogs.getState().openImport('api-1');
    await screen.findByLabelText('webhook newPet POST');
    fireEvent.click(screen.getByTestId('import-webhooks-submit'));
    await waitFor(() => expect(importWebhooks).toHaveBeenCalledTimes(1));

    // The user closes this dialog and opens it again for a different API before the reply lands.
    useWebhookItemsDialogs.getState().close();
    const webhookItemsB = vi.fn().mockResolvedValue({ ok: true, value: { items: [ITEMS[1]!], imported: [] } });
    installWirebenchApi({ api: { webhookItems: webhookItemsB, importWebhooks } });
    useWebhookItemsDialogs.getState().openImport('api-2');
    await screen.findByLabelText('callback subEvent POST');

    resolveImport({ ok: true, value: { folderId: 'folder-1', added: 2 } });
    await waitFor(() => expect(webhookItemsB).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();

    // The stale reply for api-1 must not toast, and must not close the dialog now showing api-2.
    expect(showToast).not.toHaveBeenCalled();
    expect(useWebhookItemsDialogs.getState().importFor).toEqual({ apiId: 'api-2' });
  });
});
