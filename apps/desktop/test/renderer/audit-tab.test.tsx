import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuditTab } from '../../src/renderer/features/team/audit-tab.js';
import { useAuditStore } from '../../src/renderer/state/audit.js';
import type { AuditEventWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast, ToastViewport: () => null }));

const event = (i: number, action = 'auth.signed_in'): AuditEventWire => ({
  id: `01J9ZK3V8Q000000000000000${String(i)}`,
  at: new Date(Date.UTC(2026, 9, 2, 12, i)).toISOString(),
  actor: { kind: 'user', userId: 'U1', email: 'alice@example.com' },
  action,
  target: { kind: 'user', id: 'U1' },
  workspaceId: null,
  teamId: null,
  ip: '203.0.113.7',
  userAgent: 'Wirebench/3.1.0',
  details: { method: 'local', device: 'laptop' },
});

const query = vi.fn();
const lastQuery = (mock: typeof query): Record<string, unknown> =>
  (mock.mock.lastCall?.[0] as { query: Record<string, unknown> }).query;
const exportMock = vi.fn();

describe('AuditTab (audit-log spec §3.6)', () => {
  beforeEach(() => {
    query.mockReset();
    exportMock.mockReset();
    showToast.mockReset();
    installWirebenchApi({ audit: { query, export: exportMock } });
    useAuditStore.getState().reset();
  });
  afterEach(() => cleanup());

  it('a licensing-feature-required answer shows the gated notice and no filters', async () => {
    query.mockResolvedValue({
      ok: false,
      error: { code: 'licensing-feature-required', message: 'This needs the Enterprise edition.' },
    });
    render(<AuditTab url="https://s.example" workspaces={[]} />);
    expect(await screen.findByTestId('audit-gated')).not.toBeNull();
    expect(screen.queryByTestId('audit-range')).toBeNull();
  });

  it('renders a page, opens a detail on click', async () => {
    query.mockResolvedValue({ ok: true, value: { events: [event(1), event(2, 'team.created')] } });
    render(<AuditTab url="https://s.example" workspaces={[]} />);
    expect(await screen.findAllByTestId('audit-row')).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId('audit-row')[1]!);
    expect(screen.getByTestId('audit-detail').textContent).toContain('alice@example.com');
    expect(screen.getByTestId('audit-details-json').textContent).toContain('"method": "local"');
  });

  it('changing the kind queries with the group prefix', async () => {
    query.mockResolvedValue({ ok: true, value: { events: [] } });
    render(<AuditTab url="https://s.example" workspaces={[]} />);
    await screen.findByTestId('audit-range');
    fireEvent.change(screen.getByTestId('audit-group'), { target: { value: 'auth' } });
    await waitFor(() => expect(lastQuery(query)).toMatchObject({ action: 'auth.', limit: 50 }));
  });

  it('Load more sends the cursor and appends the second page', async () => {
    query
      .mockResolvedValueOnce({ ok: true, value: { events: [event(1)], next: 'c1' } })
      .mockResolvedValueOnce({ ok: true, value: { events: [event(2)] } });
    render(<AuditTab url="https://s.example" workspaces={[]} />);
    fireEvent.click(await screen.findByTestId('audit-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('audit-row')).toHaveLength(2));
    expect(lastQuery(query)).toMatchObject({ after: 'c1' });
    expect(screen.queryByTestId('audit-load-more')).toBeNull();
  });

  it('Export… sends the filter without a limit and toasts the count', async () => {
    query.mockResolvedValue({ ok: true, value: { events: [] } });
    exportMock.mockResolvedValue({ ok: true, value: { saved: true, path: '/tmp/a.ndjson', count: 3 } });
    render(<AuditTab url="https://s.example" workspaces={[]} />);
    fireEvent.click(await screen.findByTestId('audit-export'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    const sent = lastQuery(exportMock);
    expect(sent).toMatchObject({ from: expect.any(String) as string });
    expect('limit' in sent).toBe(false);
    expect('after' in sent).toBe(false);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Exported 3 events to /tmp/a.ndjson'));
  });

  it('a selected workspace that leaves the workspaces list stops narrowing the query', async () => {
    query.mockResolvedValue({ ok: true, value: { events: [] } });
    const url = 'https://s.example';
    const { rerender } = render(<AuditTab url={url} workspaces={[{ id: 'W1', name: 'Payments' }]} />);
    fireEvent.change(await screen.findByTestId('audit-workspace'), { target: { value: 'W1' } });
    await waitFor(() => expect(lastQuery(query)).toMatchObject({ workspaceId: 'W1' }));
    const before = query.mock.calls.length;
    rerender(<AuditTab url={url} workspaces={[{ id: 'W2', name: 'Billing' }]} />);
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(before));
    expect('workspaceId' in lastQuery(query)).toBe(false);
    expect(useAuditStore.getState().filter.workspaceId).toBeUndefined();
  });

  it('a load that starts while a load-more is pending leaves the store usable', async () => {
    let answerMore: (value: unknown) => void = () => undefined;
    query
      .mockResolvedValueOnce({ ok: true, value: { events: [event(1)], next: 'c1' } })
      .mockReturnValueOnce(new Promise((resolve) => (answerMore = resolve)))
      .mockResolvedValueOnce({ ok: true, value: { events: [event(3)], next: 'c3' } })
      .mockResolvedValueOnce({ ok: true, value: { events: [event(4)] } });
    const url = 'https://s.example';
    const store = useAuditStore.getState;
    await store().load(url);
    const more = store().loadMore(url);
    await store().load(url);
    answerMore({ ok: true, value: { events: [event(2)] } });
    await more;
    expect(store().loadingMore).toBe(false);
    expect(store().events.map((e) => e.id)).toEqual([event(3).id]);
    await store().loadMore(url);
    expect(store().events.map((e) => e.id)).toEqual([event(3).id, event(4).id]);
  });
});
