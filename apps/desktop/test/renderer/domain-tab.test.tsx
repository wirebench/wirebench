import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AccountWire, CustomDomainStateWire, CustomDomainWire } from '@wirebench/wire/wire-base';
import { DOMAIN_STATE_WORDS, DomainTab, HELD_ELSEWHERE } from '../../src/renderer/features/team/domain-tab.js';
import { TeamDialog } from '../../src/renderer/features/team/team-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useDomainStore } from '../../src/renderer/state/domain.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://acme.app.test';
const NAME = 'wirebench.customer.test';
const TOKEN_VALUE = 'wirebench-domain-verification=Zm9vYmFy';
const claimIn = (state: CustomDomainStateWire, overrides: Partial<CustomDomainWire> = {}): CustomDomainWire => ({
  name: NAME,
  state,
  records: [
    { type: 'CNAME', name: NAME, value: 'custom.app.test' },
    { type: 'TXT', name: `_wirebench.${NAME}`, value: TOKEN_VALUE },
  ],
  lastResult: null,
  checkedAt: null,
  ...overrides,
});
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const fail = (code: string, message: string, details?: Record<string, unknown>) =>
  vi.fn().mockResolvedValue({ ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } });

function install(domain: CustomDomainWire | null, overrides: Record<string, unknown> = {}) {
  return installWirebenchApi({
    domain: {
      get: ok({ domain }),
      claim: ok({ domain: claimIn('pending') }),
      check: ok({ domain }),
      remove: ok({ removed: true }),
      ...overrides,
    },
  });
}

describe('DomainTab (hosted edition spec §23.6)', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    useDomainStore.getState().reset();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => cleanup());

  it.each(Object.keys(DOMAIN_STATE_WORDS) as CustomDomainStateWire[])('says what %s means', async (state) => {
    install(claimIn(state));
    render(<DomainTab url={URL_} />);
    expect((await screen.findByTestId('domain-state')).textContent).toBe(DOMAIN_STATE_WORDS[state].label);
    expect(screen.getByTestId('domain-state-detail').textContent).toBe(DOMAIN_STATE_WORDS[state].detail);
    expect(screen.getByTestId('domain-name').textContent).toBe(NAME);
    // An expired claim stays until removed (spec §23.2), so checking it again does nothing.
    expect(screen.queryByTestId('domain-check') !== null).toBe(state !== 'expired');
    expect(screen.getByTestId('domain-remove')).toBeTruthy();
    expect(screen.queryByTestId('domain-idp-notice') !== null).toBe(state === 'active');
  });

  it('every state has its own words', () => {
    const labels = Object.values(DOMAIN_STATE_WORDS).map((words) => words.label);
    expect(new Set(labels).size).toBe(7);
  });

  it('shows both records with a copy button for each name and value', async () => {
    install(claimIn('pending'));
    render(<DomainTab url={URL_} />);
    expect((await screen.findByTestId('domain-record-0-type')).textContent).toBe('CNAME');
    expect(screen.getByTestId('domain-record-0-value').textContent).toBe('custom.app.test');
    expect(screen.getByTestId('domain-record-1-type').textContent).toBe('TXT');
    expect(screen.getByTestId('domain-record-1-name').textContent).toBe(`_wirebench.${NAME}`);
    fireEvent.click(screen.getByTestId('domain-record-0-value-copy'));
    expect(writeText).toHaveBeenLastCalledWith('custom.app.test');
    fireEvent.click(screen.getByTestId('domain-record-1-value-copy'));
    expect(writeText).toHaveBeenLastCalledWith(TOKEN_VALUE);
    fireEvent.click(screen.getByTestId('domain-record-1-name-copy'));
    expect(writeText).toHaveBeenLastCalledWith(`_wirebench.${NAME}`);
    fireEvent.click(screen.getByTestId('domain-record-0-name-copy'));
    expect(writeText).toHaveBeenLastCalledWith(NAME);
  });

  it('tells the admin to update the identity provider once the name is active', async () => {
    install(claimIn('active'));
    render(<DomainTab url={URL_} />);
    const notice = await screen.findByTestId('domain-idp-notice');
    expect(notice.textContent).toContain(NAME);
    expect(notice.textContent).toContain('redirect URI');
    expect(notice.textContent).toContain('ACS URL');
  });

  it('shows the last result as text and when it was checked', async () => {
    const message = 'The CNAME at x points to "<img src=x onerror=alert(1)>", not custom.app.test.';
    install(
      claimIn('pending', {
        lastResult: { cname: 'wrong', txt: 'missing', message },
        checkedAt: '2026-11-04T10:05:00.000Z',
      }),
    );
    const { container } = render(<DomainTab url={URL_} />);
    expect((await screen.findByTestId('domain-last-result')).textContent).toBe(message);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('domain-checked-at').textContent).toBe('2026-11-04 10:05 UTC');
  });

  it('says Not checked yet before the first check', async () => {
    install(claimIn('pending'));
    render(<DomainTab url={URL_} />);
    expect((await screen.findByTestId('domain-checked-at')).textContent).toBe('Not checked yet');
    expect(screen.queryByTestId('domain-last-result')).toBeNull();
  });

  it('says a name is held elsewhere without naming who holds it', async () => {
    install(
      claimIn('pending', {
        lastResult: { cname: 'ok', txt: 'ok', heldElsewhere: true, message: 'Another team holds this name.' },
        checkedAt: '2026-11-04T10:05:00.000Z',
      }),
    );
    render(<DomainTab url={URL_} />);
    expect((await screen.findByTestId('domain-held-elsewhere')).textContent).toBe(HELD_ELSEWHERE);
  });

  it('hints that an apex cannot hold a CNAME, and not for a subdomain', async () => {
    install(claimIn('pending', { name: 'customer.test' }));
    render(<DomainTab url={URL_} />);
    expect(await screen.findByTestId('domain-apex-hint')).toBeTruthy();
    cleanup();
    useDomainStore.getState().reset();
    install(claimIn('pending'));
    render(<DomainTab url={URL_} />);
    await screen.findByTestId('domain-state');
    expect(screen.queryByTestId('domain-apex-hint')).toBeNull();
  });

  it('claims a name and then shows its records', async () => {
    const api = install(null);
    render(<DomainTab url={URL_} />);
    fireEvent.change(await screen.findByTestId('domain-name-input'), { target: { value: ` ${NAME} ` } });
    fireEvent.click(screen.getByTestId('domain-claim'));
    expect(await screen.findByTestId('domain-records')).toBeTruthy();
    expect(api.domain.claim).toHaveBeenCalledWith({ url: URL_, name: NAME });
  });

  it('shows a refused claim in the server’s words', async () => {
    install(null, { claim: fail('custom-name-ours', 'That name belongs to this service.') });
    render(<DomainTab url={URL_} />);
    fireEvent.change(await screen.findByTestId('domain-name-input'), { target: { value: 'acme.app.test' } });
    fireEvent.click(screen.getByTestId('domain-claim'));
    expect((await screen.findByTestId('domain-error')).textContent).toBe('That name belongs to this service.');
    expect(screen.getByTestId<HTMLInputElement>('domain-name-input').value).toBe('acme.app.test');
  });

  it('Check now shows the new state, and a 429 as the seconds to wait', async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { domain: claimIn('verified') } })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'custom-domains-check-rate-limited',
          message: 'This name was checked less than a minute ago.',
          details: { status: 429, retryAfterMs: 41_200 },
        },
      });
    install(claimIn('pending'), { check });
    render(<DomainTab url={URL_} />);
    fireEvent.click(await screen.findByTestId('domain-check'));
    await waitFor(() => expect(screen.getByTestId('domain-state').textContent).toBe(DOMAIN_STATE_WORDS.verified.label));
    fireEvent.click(screen.getByTestId('domain-check'));
    expect((await screen.findByTestId('domain-error')).textContent).toBe(
      'This name was checked less than a minute ago. Try again in 42 seconds.',
    );
    expect(check).toHaveBeenCalledWith({ url: URL_ });
  });

  it('removes the name only after the confirmation', async () => {
    const api = install(claimIn('active'));
    render(<DomainTab url={URL_} />);
    fireEvent.click(await screen.findByTestId('domain-remove'));
    expect(api.domain.remove).not.toHaveBeenCalled();
    expect((await screen.findByTestId('domain-remove-confirm')).textContent).toContain('identity provider');
    fireEvent.click(screen.getByTestId('domain-remove-confirm-button'));
    await waitFor(() => expect(api.domain.remove).toHaveBeenCalledWith({ url: URL_ }));
    expect(await screen.findByTestId('domain-name-input')).toBeTruthy();
  });
});

describe('the Domain tab in the team dialog', () => {
  const account: AccountWire = {
    url: URL_,
    userId: 'me',
    email: 'me@acme.test',
    displayName: 'Me',
    deviceName: 'd',
    signedOut: false,
    addedAt: '2026-11-01T12:00:00.000Z',
  };
  const team = { list: ok({ teams: [], serverAdmin: true }), listWorkspaces: ok({ workspaces: [] }) };

  beforeEach(() => {
    useTeamStore.getState().reset();
    useDomainStore.getState().reset();
    useAccountStore.setState({ servers: [account], loaded: true });
    useUiStore.setState({ teamDialog: { open: true, url: URL_ }, signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => cleanup());

  it('shows the tab to a server admin of a hosted server with the feature', async () => {
    installWirebenchApi({ team, domain: { get: ok({ domain: claimIn('pending') }) } });
    render(<TeamDialog />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Domain' }));
    expect(await screen.findByTestId('domain-tab')).toBeTruthy();
    expect(screen.getByTestId('domain-name').textContent).toBe(NAME);
  });

  it.each([
    ['a self-hosted server', 'custom-domains-hosted-only'],
    ['a tenant without the feature', 'licensing-feature-required'],
  ])('hides the tab on %s', async (_label, code) => {
    const get = fail(code, 'No.');
    installWirebenchApi({ team, domain: { get } });
    render(<TeamDialog />);
    await screen.findByRole('tab', { name: 'License' });
    await waitFor(() => expect(get).toHaveBeenCalledWith({ url: URL_ }));
    expect(screen.queryByRole('tab', { name: 'Domain' })).toBeNull();
  });

  it('does not ask a member who is not a server admin', async () => {
    const get = ok({ domain: null });
    installWirebenchApi({
      team: {
        list: ok({
          teams: [{ id: 'T1', name: 'QA', myRole: 'admin', createdAt: '2026-11-01T12:00:00.000Z' }],
          serverAdmin: false,
        }),
        listWorkspaces: ok({ workspaces: [] }),
        members: ok({ members: [] }),
        invitations: ok({ invitations: [] }),
      },
      domain: { get },
    });
    render(<TeamDialog />);
    await screen.findByRole('tab', { name: 'Members' });
    expect(screen.queryByRole('tab', { name: 'Domain' })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
