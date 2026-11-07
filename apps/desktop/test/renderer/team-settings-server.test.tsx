/**
 * Team settings › Server (settings split spec §3; rulings 7, 8, 9, 16): the Server group a server admin sees, against
 * the stubbed `ipc()`. These are the assertions the desktop's Settings › Server e2e made (ruling 16): the group shows
 * for a server admin with the team's name, and the OIDC card sends the typed secret once, then shows it as Set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  AccountWire,
  ServerSettingsSectionStateWire,
  ServerSettingsWire,
  TeamWire,
  TenantBillingWire,
} from '@wirebench/wire/wire-base';
import { TeamSettings } from '../../src/renderer/features/team/settings/team-settings.js';
import { useServerSettingsStore } from '../../src/renderer/features/preferences/server/server-settings-store.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useDomainStore } from '../../src/renderer/state/domain.js';
import { useProvisioningStore } from '../../src/renderer/state/provisioning.js';
import { useTeamStore } from '../../src/renderer/state/team.js';
import { useUiStore, type TeamSettingsTarget } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://acme.app.test';
const account: AccountWire = {
  url: URL_,
  userId: 'root',
  email: 'root@acme.test',
  displayName: 'Root',
  deviceName: 'd',
  signedOut: false,
  addedAt: '2026-09-24T12:00:00.000Z',
};
const TEAM: TeamWire = { id: 'T1', name: 'Payments QA', myRole: 'admin', createdAt: '2026-09-25T10:00:00.000Z' };

const answer = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const refusal = (code: string, status: number) =>
  vi.fn().mockResolvedValue({ ok: false, error: { code, message: code, details: { status } } });

const unset: ServerSettingsSectionStateWire = { source: 'tenant', writable: true, value: null };
const HOSTED: ServerSettingsWire = {
  source: 'tenant',
  sections: {
    oidc: unset,
    saml: unset,
    auditForward: unset,
    smtp: unset,
    retention: unset,
    budgets: { source: 'tenant', writable: false, value: null },
  },
};
const fromEnv = (value: Record<string, unknown> | null): ServerSettingsSectionStateWire => ({
  source: 'environment',
  writable: false,
  value,
});
const SELF_HOSTED: ServerSettingsWire = {
  source: 'environment',
  sections: {
    oidc: fromEnv({
      issuer: 'https://idp.corp.example',
      clientId: 'wirebench',
      scopes: ['openid', 'email'],
      displayName: 'Corp SSO',
      clientSecret: { set: true },
    }),
    saml: fromEnv(null),
    auditForward: fromEnv(null),
    smtp: fromEnv(null),
    retention: fromEnv(null),
    budgets: fromEnv(null),
  },
};
const BILLING: TenantBillingWire = {
  // Not the address's first label: the slug and name are the server's.
  slug: 'acme-team',
  name: 'Acme Ltd',
  activeMembers: 12,
  edition: 'team',
  editionSource: 'subscription',
  status: 'active',
  suspendedReason: null,
  subscription: {
    plan: 'team',
    seats: 15,
    status: 'active',
    currentPeriodEnd: '2026-11-30T00:00:00.000Z',
    pastDueSince: null,
    pastDueDaysLeft: null,
  },
  deletion: null,
};

/** A server admin of one team, on a server whose settings read answers `settings` (or is refused when `undefined`). */
function install(settings: ServerSettingsWire | undefined, extra: Record<string, unknown> = {}) {
  return installWirebenchApi({
    team: {
      list: answer({ teams: [TEAM], serverAdmin: true }),
      listWorkspaces: answer({ workspaces: [] }),
      members: answer({ members: [] }),
      invitations: answer({ invitations: [] }),
    },
    serverSettings: { get: settings === undefined ? refusal('not-found', 404) : answer(settings) },
    tenantBilling: { get: answer(BILLING) },
    domain: { get: refusal('custom-domains-hosted-only', 404) },
    audit: { query: answer({ events: [] }), export: answer({ saved: false }) },
    provisioning: {
      info: answer({ configured: false, entityId: 'e', acsUrl: 'a', scimBaseUrl: `${URL_}/scim/v2` }),
      listTokens: answer({ tokens: [] }),
      listGroups: answer({
        groups: [{ id: 'G1', displayName: 'Engineers', memberCount: 3, team: null }],
      }),
    },
    ...extra,
  });
}

function show(target: TeamSettingsTarget) {
  useUiStore.getState().openTeamSettings(target);
  return render(<TeamSettings target={target} />);
}

const navIds = (): string[] =>
  [...screen.getByTestId('team-settings').querySelectorAll('[data-testid^="team-settings-nav-"]')].map(
    (item) => item.getAttribute('data-testid')?.slice('team-settings-nav-'.length) ?? '',
  );

describe('Team settings › Server (settings split spec §3, ruling 16)', () => {
  beforeEach(() => {
    useTeamStore.getState().reset();
    useServerSettingsStore.getState().reset();
    useDomainStore.getState().reset();
    useProvisioningStore.getState().reset();
    useAccountStore.setState({ servers: [account], loaded: true });
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUiStore.getState().setPreferencesOpen(false);
    window.history.replaceState(null, '', '/');
  });

  it('a hosted team’s server admin sees the Server group with the team’s name, Billing and Close this account', async () => {
    install(HOSTED);
    show({ teamId: 'T1', page: 'sign-in' });
    const page = await screen.findByTestId('server-page-sign-in');
    // The team's own name, from its billing answer, not the first label of its address.
    await waitFor(() => expect(page.textContent).toContain('How people sign in to Acme Ltd.'));
    expect(page.querySelector('h1')?.textContent).toBe('Sign-in');
    expect(navIds()).toEqual(
      expect.arrayContaining(['license', 'sign-in', 'provisioning', 'email', 'audit', 'billing', 'close-account']),
    );
    expect(screen.getByTestId('team-settings-nav-close-account').textContent).toBe('Close this account');
  });

  it('a self-hosted server shows its settings read-only, without Billing and Close this account', async () => {
    install(SELF_HOSTED);
    show({ teamId: 'T1', page: 'sign-in' });
    const page = await screen.findByTestId('server-page-sign-in');
    expect(page.textContent).toContain('Read-only here');
    const oidc = within(page).getByTestId('server-oidc');
    expect(oidc.textContent).toContain('WIREBENCH_SERVER_OIDC_ISSUER');
    expect(oidc.querySelector('input')).toBeNull();
    expect(navIds()).toContain('email');
    expect(navIds()).not.toContain('billing');
    expect(navIds()).not.toContain('close-account');
  });

  it('Sign-in sends a typed client secret once and then shows it as Set', async () => {
    const connected: ServerSettingsWire = {
      ...HOSTED,
      sections: {
        ...HOSTED.sections,
        oidc: {
          source: 'tenant',
          writable: true,
          value: {
            issuer: 'https://login.acme.example',
            clientId: 'wirebench',
            scopes: ['openid', 'email', 'profile'],
            displayName: 'Sign in with Acme SSO',
            clientSecret: { set: true },
          },
          updatedAt: '2026-11-07T10:00:00.000Z',
        },
      },
    };
    const save = answer(connected);
    install(HOSTED, { serverSettings: { get: answer(HOSTED), save } });
    show({ teamId: 'T1', page: 'sign-in' });
    const card = await screen.findByTestId('server-oidc');
    expect(within(card).getByTestId('server-oidc-state').textContent).toBe('Not set up');
    fireEvent.change(within(card).getByTestId('server-oidc-issuer'), {
      target: { value: 'https://login.acme.example' },
    });
    fireEvent.change(within(card).getByTestId('server-oidc-client-id'), { target: { value: 'wirebench' } });
    fireEvent.change(within(card).getByTestId('server-oidc-secret-input'), {
      target: { value: 'client-secret-value' },
    });
    fireEvent.click(within(card).getByTestId('server-oidc-save'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      url: URL_,
      section: 'oidc',
      value: { issuer: 'https://login.acme.example', clientId: 'wirebench', clientSecret: 'client-secret-value' },
    });
    await waitFor(() => expect(within(card).getByTestId('server-oidc-secret-state').textContent).toBe('Set'));
    expect(within(card).queryByTestId('server-oidc-secret-input')).toBeNull();
    // The secret is never put back on the page.
    expect(screen.getByTestId('team-settings').textContent).not.toContain('client-secret-value');
  });

  it('Provisioning shows the SCIM card, then the groups card', async () => {
    install(HOSTED);
    show({ teamId: 'T1', page: 'provisioning' });
    const page = await screen.findByTestId('team-page-provisioning');
    expect(page.querySelector('h1')?.textContent).toBe('Provisioning');
    const scim = await within(page).findByTestId('server-scim');
    const groups = await within(page).findByTestId('provisioning-group-G1');
    expect(scim.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One SCIM card: the groups card does not repeat the tokens.
    expect(within(page).queryByTestId('provisioning-tokens')).toBeNull();
  });

  it('Close this account asks for the slug, then requests the deletion', async () => {
    const deletion = {
      requestedAt: '2026-11-07T09:00:00.000Z',
      deletingAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    };
    const request = answer({ deletion });
    install(HOSTED, { tenantDeletion: { request } });
    show({ teamId: 'T1', page: 'close-account' });
    const page = await screen.findByTestId('server-page-close-account');
    await waitFor(() => expect(page.textContent).toContain('Type acme-team to confirm'));
    expect(within(page).getByTestId('server-delete-card').textContent).toContain('Close this account');
    expect(page.textContent).not.toContain('Delete team');
    // The page that closes the account carries no banner about closing it.
    expect(within(page).queryByTestId('server-deletion-banner')).toBeNull();
    expect(within(page).getByTestId('server-delete-request')).toHaveProperty('disabled', true);
    fireEvent.change(within(page).getByTestId('server-delete-slug'), { target: { value: 'acme-team' } });
    fireEvent.click(within(page).getByTestId('server-delete-request'));
    const confirm = await screen.findByTestId('server-delete-confirm');
    expect(screen.getByRole('alertdialog').textContent).toContain('Close this account?');
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ url: URL_, slug: 'acme-team' }));
  });

  it('while the account is closing, every other Server page says so', async () => {
    const deletion = {
      requestedAt: '2026-11-07T09:00:00.000Z',
      deletingAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    };
    install(HOSTED, { tenantBilling: { get: answer({ ...BILLING, deletion }) } });
    show({ teamId: 'T1', page: 'sign-in' });
    const banner = await screen.findByTestId('server-deletion-banner');
    expect(banner.textContent).toContain('This account is being closed');
    expect(banner.textContent).toContain('in 3 days');
    expect(banner.textContent).toContain('from Close this account');
    expect(banner.textContent).not.toContain('team is being deleted');
  });

  it('an older server without settings routes shows License, Provisioning and Audit log only', async () => {
    install(undefined);
    show({ teamId: 'T1', page: 'provisioning' });
    const page = await screen.findByTestId('team-page-provisioning');
    expect(screen.getByTestId('team-settings').querySelector('nav')?.textContent).toContain('Server');
    expect(navIds().filter((id) => !['overview', 'people', 'workspaces', 'roles'].includes(id))).toEqual([
      'license',
      'provisioning',
      'audit',
    ]);
    // Without the settings read there is no SCIM card of its own: the provisioning tab keeps its tokens.
    expect(within(page).queryByTestId('server-scim')).toBeNull();
    expect(await within(page).findByTestId('provisioning-tokens')).toBeTruthy();
  });
});
