/**
 * Update Definition for an AsyncAPI-imported WebSocket API: the card opens a dialog that shows what
 * the source would change, per operation, and applies exactly the plan it showed — the fingerprint
 * goes back, and a source that changed in between is said so, with a way to look again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AsyncApiDefinitionCard } from '../../src/renderer/features/ws-api/asyncapi-definition-card.js';
import { AsyncApiUpdateDialog } from '../../src/renderer/features/ws-api/asyncapi-update-dialog.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PLAN = {
  added: [{ key: 'sendTyping', channel: 'typing', direction: 'sent' as const }],
  removed: [{ key: 'legacyPing', channel: 'ping', direction: 'received' as const }],
  changed: [
    {
      op: { key: 'sendMessage', channel: 'userChat', direction: 'sent' as const },
      reasons: ['address' as const, 'payload' as const],
    },
  ],
  fingerprint: 'sha-1',
};

const APPLIED = {
  project: { id: 'p1' },
  plan: PLAN,
  applied: {
    requestsAdded: ['r-new'],
    requestsOrphaned: ['r-old'],
    requestsRestored: [],
    requestsRewritten: ['r-chat'],
    messagesReplaced: [],
    messagesAdded: [],
  },
};

function renderCard() {
  render(
    <AsyncApiDefinitionCard
      apiId="ws-api-1"
      definition={{ kind: 'asyncapi', source: 'https://example.com/chat.yaml', cache: true }}
    />,
  );
}

describe('AsyncApiDefinitionCard', () => {
  it('shows where the contract came from', () => {
    installWirebenchApi({});
    renderCard();
    expect(screen.getByTestId('asyncapi-definition-card').textContent).toContain('https://example.com/chat.yaml');
  });

  it('shows the declared version and the WebSocket servers, the chosen one marked', () => {
    installWirebenchApi({});
    render(
      <AsyncApiDefinitionCard
        apiId="ws-api-1"
        definition={{
          kind: 'asyncapi',
          source: 'https://example.com/chat.yaml',
          cache: true,
          server: 'staging',
          version: '3.0.0',
          servers: ['public', 'staging'],
        }}
      />,
    );
    expect(screen.getByTestId('asyncapi-definition-version').textContent).toContain('3.0.0');
    expect(screen.getByTestId('asyncapi-definition-servers').textContent).toContain('public, staging (chosen)');
  });

  it('falls back to the first server as the chosen one when none was recorded', () => {
    installWirebenchApi({});
    render(
      <AsyncApiDefinitionCard
        apiId="ws-api-1"
        definition={{ kind: 'asyncapi', source: 's', cache: true, version: '2.6.0', servers: ['public', 'staging'] }}
      />,
    );
    expect(screen.getByTestId('asyncapi-definition-servers').textContent).toContain('public (chosen), staging');
  });

  it('still records an apply that lands after the dialog unmounted, but no longer drives the dialog', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    const apply = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    installWirebenchApi({ api: { asyncApiPlanUpdate: plan, asyncApiApplyUpdate: apply } });
    const applySnapshot = vi.fn();
    useProjectStore.setState({ applySnapshot, projectOf: { 'ws-api-1': 'p1' } } as never);
    const onOpenChange = vi.fn();
    const view = render(<AsyncApiUpdateDialog apiId="ws-api-1" open onOpenChange={onOpenChange} />);
    fireEvent.click(await screen.findByTestId('asyncapi-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalled());
    view.unmount();
    answer({ ok: true, value: APPLIED });
    await waitFor(() => expect(applySnapshot).toHaveBeenCalledWith('p1', APPLIED.project));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('lists added, removed and changed operations with reasons, and applies with the fingerprint', async () => {
    const plan = vi.fn().mockResolvedValue({ ok: true, value: PLAN });
    const apply = vi.fn().mockResolvedValue({ ok: true, value: APPLIED });
    installWirebenchApi({ api: { asyncApiPlanUpdate: plan, asyncApiApplyUpdate: apply } });
    const applySnapshot = vi.fn();
    useProjectStore.setState({ applySnapshot, projectOf: { 'ws-api-1': 'p1' } } as never);

    renderCard();
    fireEvent.click(screen.getByTestId('asyncapi-definition-update'));

    await waitFor(() => expect(plan).toHaveBeenCalledWith({ apiId: 'ws-api-1' }));
    const added = await screen.findByTestId('asyncapi-update-added');
    expect(added.textContent).toContain('sendTyping');
    expect(screen.getByTestId('asyncapi-update-removed').textContent).toContain('legacyPing');
    const changed = within(screen.getByTestId('asyncapi-update-changed')).getAllByRole('listitem');
    expect(changed[0]!.textContent).toContain('sendMessage');
    expect(changed[0]!.textContent).toContain('address, payload');

    fireEvent.click(screen.getByTestId('asyncapi-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ apiId: 'ws-api-1', fingerprint: 'sha-1' }));
    await waitFor(() => expect(applySnapshot).toHaveBeenCalledWith('p1', APPLIED.project));
    await waitFor(() => expect(screen.queryByTestId('asyncapi-update-dialog')).toBeNull());
  });

  it('asks for nothing, and says so when the source needs credentials it was not given', async () => {
    const message = 'The definition at https://example.com/chat.yaml needs authentication (HTTP 401).';
    const plan = vi.fn().mockResolvedValue({ ok: false, error: { code: 'definition-auth-required', message } });
    installWirebenchApi({ api: { asyncApiPlanUpdate: plan } });

    renderCard();
    fireEvent.click(screen.getByTestId('asyncapi-definition-update'));

    await waitFor(() => expect(plan).toHaveBeenCalledWith({ apiId: 'ws-api-1' }));
    expect((await screen.findByTestId('asyncapi-update-error')).textContent).toBe(message);
    expect(screen.queryByTestId('definition-auth')).toBeNull();
  });

  it('says so when the source changed since the preview, and previews again on request', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: PLAN })
      .mockResolvedValueOnce({ ok: true, value: { ...PLAN, fingerprint: 'sha-2' } });
    const apply = vi.fn().mockResolvedValueOnce({
      ok: false,
      error: { code: 'definition-changed', message: 'The definition changed since it was previewed' },
    });
    installWirebenchApi({ api: { asyncApiPlanUpdate: plan, asyncApiApplyUpdate: apply } });

    renderCard();
    fireEvent.click(screen.getByTestId('asyncapi-definition-update'));
    await screen.findByTestId('asyncapi-update-added');
    fireEvent.click(screen.getByTestId('asyncapi-update-apply'));

    const alert = await screen.findByTestId('asyncapi-update-changed-since');
    expect(alert.textContent).toContain('changed since');
    fireEvent.click(screen.getByTestId('asyncapi-update-replan'));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('asyncapi-update-changed-since')).toBeNull());

    apply.mockResolvedValueOnce({ ok: true, value: APPLIED });
    fireEvent.click(screen.getByTestId('asyncapi-update-apply'));
    await waitFor(() => expect(apply).toHaveBeenLastCalledWith({ apiId: 'ws-api-1', fingerprint: 'sha-2' }));
  });

  it('says nothing would change when the plan is empty', async () => {
    installWirebenchApi({
      api: {
        asyncApiPlanUpdate: vi
          .fn()
          .mockResolvedValue({ ok: true, value: { added: [], removed: [], changed: [], fingerprint: 'f' } }),
      },
    });
    renderCard();
    fireEvent.click(screen.getByTestId('asyncapi-definition-update'));
    expect((await screen.findByTestId('asyncapi-update-empty')).textContent).toContain('already matches');
  });
});
