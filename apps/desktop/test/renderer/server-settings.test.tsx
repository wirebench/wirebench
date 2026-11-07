/**
 * The *Server* page of Settings (hosted edition spec §22.13), one describe per section: what each card shows from the
 * server's view, what it sends on *Check and save*, and the read-only form a self-hosted server's sections take.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  ServerSettingsSectionStateWire,
  ServerSettingsWire,
  TenantBillingWire,
  TenantExportWire,
} from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  serverPages,
  settingsServerUrl,
  useServerSettingsStore,
} from '../../src/renderer/features/preferences/server/server-settings-store.js';
import { ServerPage } from '../../src/renderer/features/preferences/server/server-page.js';
import { SignInSection } from '../../src/renderer/features/preferences/server/sign-in-section.js';
import { ProvisioningSection } from '../../src/renderer/features/preferences/server/provisioning-section.js';
import { AuditForwardingSection } from '../../src/renderer/features/preferences/server/audit-forwarding-section.js';
import { EmailSection, smtpUrl } from '../../src/renderer/features/preferences/server/email-section.js';
import { RetentionSection } from '../../src/renderer/features/preferences/server/retention-section.js';
import { BillingSection, formatDate } from '../../src/renderer/features/preferences/server/billing-section.js';
import { ExportSection, exportFailureText } from '../../src/renderer/features/preferences/server/export-section.js';
import { CloseAccountSection } from '../../src/renderer/features/preferences/server/close-account-section.js';
import { useProvisioningStore } from '../../src/renderer/state/provisioning.js';

const URL_ = 'https://acme.app.test';
const ok = <T,>(value: T) => ({ ok: true as const, value });
const refused = (code: string, message: string, status = 400) => ({
  ok: false as const,
  error: { code, message, details: { status } },
});

const unset = (
  source: 'tenant' | 'environment' = 'tenant',
  writable = source === 'tenant',
): ServerSettingsSectionStateWire => ({
  source,
  writable,
  value: null,
});
const set = (value: Record<string, unknown>): ServerSettingsSectionStateWire => ({
  source: 'tenant',
  writable: true,
  value,
  updatedAt: '2026-11-04T10:00:00.000Z',
});

function view(sections: Partial<ServerSettingsWire['sections']> = {}): ServerSettingsWire {
  return {
    source: 'tenant',
    sections: {
      oidc: unset(),
      saml: unset(),
      auditForward: unset(),
      smtp: unset(),
      retention: unset(),
      budgets: unset('tenant', false),
      twoFactor: unset(),
      ...sections,
    },
  };
}

function environment(sections: Partial<ServerSettingsWire['sections']> = {}): ServerSettingsWire {
  const env = (value: Record<string, unknown> | null): ServerSettingsSectionStateWire => ({
    source: 'environment',
    writable: false,
    value,
  });
  return {
    source: 'environment',
    sections: {
      oidc: env({
        issuer: 'https://idp.corp.example',
        clientId: 'wirebench',
        scopes: ['openid', 'email'],
        displayName: 'Corp SSO',
        clientSecret: { set: true },
      }),
      saml: env(null),
      auditForward: env(null),
      smtp: env({ url: 'smtps://smtp.corp.example/', from: 'wb@corp.example', credentials: { set: true } }),
      retention: env({
        auditMaxAgeDays: 365,
        hooksMaxAgeDays: 30,
        hooksKeep: 500,
        schedulesMaxAgeDays: 90,
        sessionLogMaxMb: 64,
      }),
      budgets: env({ sendsPerMinute: 600, burst: 100, concurrentSends: 8, runSlots: 4 }),
      twoFactor: env({ required: false }),
      ...sections,
    },
  };
}

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
    status: 'past_due',
    currentPeriodEnd: '2026-11-30T00:00:00.000Z',
    pastDueSince: '2026-11-04T10:00:00.000Z',
    pastDueDaysLeft: 11,
  },
  deletion: null,
};

/** Puts `settings` (and `billing`) in the store as a load would. */
function loaded(settings: ServerSettingsWire, billing: TenantBillingWire | undefined = undefined): void {
  useServerSettingsStore.setState({ url: URL_, available: true, loaded: true, settings, billing });
}

beforeEach(() => {
  installWirebenchApi();
  useServerSettingsStore.getState().reset();
  useProvisioningStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the store', () => {
  it('shows the group to a server admin, and loads a hosted team’s billing', async () => {
    const get = vi.fn().mockResolvedValue(ok(view()));
    const billing = vi.fn().mockResolvedValue(ok(BILLING));
    installWirebenchApi({ serverSettings: { get }, tenantBilling: { get: billing } });
    await useServerSettingsStore.getState().load(URL_);
    expect(useServerSettingsStore.getState()).toMatchObject({ available: true, url: URL_, billing: BILLING });
    expect(get).toHaveBeenCalledWith({ url: URL_ });
  });

  it('hides the group from anyone else, and reads no billing on a self-hosted server', async () => {
    installWirebenchApi({
      serverSettings: { get: vi.fn().mockResolvedValue(refused('identity-forbidden', 'Server admins only.', 403)) },
    });
    await useServerSettingsStore.getState().load(URL_);
    expect(useServerSettingsStore.getState().available).toBe(false);

    const billing = vi.fn();
    installWirebenchApi({
      serverSettings: { get: vi.fn().mockResolvedValue(ok(environment())) },
      tenantBilling: { get: billing },
    });
    await useServerSettingsStore.getState().load(URL_);
    expect(useServerSettingsStore.getState().available).toBe(true);
    expect(billing).not.toHaveBeenCalled();
  });
});

describe('settingsServerUrl', () => {
  const servers = [{ url: 'https://first.example' }, { url: 'https://team.example' }];

  it('follows the open workspace’s server when it is one of the signed-in ones', () => {
    expect(settingsServerUrl(servers, 'https://team.example')).toBe('https://team.example');
    expect(settingsServerUrl(servers, 'https://team.example/')).toBe('https://team.example');
  });

  it('keeps the first otherwise', () => {
    expect(settingsServerUrl(servers, undefined)).toBe('https://first.example');
    expect(settingsServerUrl(servers, 'https://elsewhere.example')).toBe('https://first.example');
    expect(settingsServerUrl([], 'https://team.example')).toBeUndefined();
  });
});

describe('Sign-in', () => {
  const OIDC = {
    issuer: 'https://login.acme.example',
    clientId: 'wirebench',
    scopes: ['openid', 'email', 'profile'],
    displayName: 'Sign in with Acme SSO',
    clientSecret: { set: true },
  };

  it('shows a stored client secret as Set, never its value, and saves without it until it is replaced', async () => {
    const save = vi.fn().mockResolvedValue(ok(view({ oidc: set(OIDC) })));
    installWirebenchApi({ serverSettings: { save } });
    loaded(view({ oidc: set(OIDC) }));
    render(<SignInSection />);
    const card = screen.getByTestId('server-oidc');
    expect(within(card).getByTestId('server-oidc-state').textContent).toBe('Connected');
    expect(within(card).getByTestId('server-oidc-secret-state').textContent).toBe('Set');
    expect(screen.getByTestId('server-oidc-issuer')).toHaveProperty('value', OIDC.issuer);
    expect(screen.getByTestId('server-oidc-redirect').textContent).toBe(`${URL_}/api/v1/auth/oidc/callback`);

    fireEvent.change(screen.getByTestId('server-oidc-display-name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('server-oidc-save'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      url: URL_,
      section: 'oidc',
      value: { issuer: OIDC.issuer, clientId: 'wirebench', scopes: OIDC.scopes, displayName: 'Acme' },
    });

    fireEvent.click(screen.getByTestId('server-oidc-secret-replace'));
    fireEvent.change(screen.getByTestId('server-oidc-secret-input'), { target: { value: ' s3cret ' } });
    fireEvent.click(screen.getByTestId('server-oidc-save'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toMatchObject({ value: { clientSecret: 's3cret' } });
  });

  it('asks for the secret of a new provider before sending, and shows the server’s refusal', async () => {
    const save = vi
      .fn()
      .mockResolvedValue(refused('settings-invalid', 'The issuer’s discovery document did not answer.'));
    installWirebenchApi({ serverSettings: { save } });
    loaded(view());
    render(<SignInSection />);
    expect(screen.getByTestId('server-oidc-state').textContent).toBe('Not set up');
    fireEvent.change(screen.getByTestId('server-oidc-issuer'), { target: { value: 'https://login.acme.example' } });
    fireEvent.change(screen.getByTestId('server-oidc-client-id'), { target: { value: 'wirebench' } });
    fireEvent.click(screen.getByTestId('server-oidc-save'));
    expect(screen.getByTestId('server-oidc-error').textContent).toBe('Enter the client secret.');
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('server-oidc-secret-input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('server-oidc-save'));
    await vi.waitFor(() =>
      expect(screen.getByTestId('server-oidc-error').textContent).toBe(
        'The issuer’s discovery document did not answer.',
      ),
    );
    expect(screen.queryByTestId('server-oidc-remove')).toBeNull();
  });

  it('opens the secret field when the server refuses a new issuer with the stored secret kept', async () => {
    const save = vi
      .fn()
      .mockResolvedValue(
        refused(
          'settings-invalid',
          'The OIDC client secret must be given again when the issuer or the client id changes.',
        ),
      );
    installWirebenchApi({ serverSettings: { save } });
    loaded(view({ oidc: set(OIDC) }));
    render(<SignInSection />);
    expect(screen.queryByTestId('server-oidc-secret-input')).toBeNull();
    fireEvent.change(screen.getByTestId('server-oidc-issuer'), { target: { value: 'https://login.other.example' } });
    fireEvent.click(screen.getByTestId('server-oidc-save'));
    await vi.waitFor(() => expect(screen.getByTestId('server-oidc-secret-input')).toBeTruthy());
    expect(screen.getByTestId('server-oidc-error').textContent).toContain('must be given again');
  });

  it('leaves the secret field closed on another refusal of the same issuer', async () => {
    const save = vi
      .fn()
      .mockResolvedValue(refused('settings-invalid', 'The issuer’s discovery document did not answer.'));
    installWirebenchApi({ serverSettings: { save } });
    loaded(view({ oidc: set(OIDC) }));
    render(<SignInSection />);
    fireEvent.change(screen.getByTestId('server-oidc-display-name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('server-oidc-save'));
    await vi.waitFor(() => expect(screen.getByTestId('server-oidc-error').textContent).toContain('did not answer'));
    expect(screen.queryByTestId('server-oidc-secret-input')).toBeNull();
  });

  it('removes a provider, and saves SAML metadata with its options', async () => {
    const clear = vi.fn().mockResolvedValue(ok(view()));
    const save = vi.fn().mockResolvedValue(ok(view()));
    installWirebenchApi({ serverSettings: { clear, save } });
    loaded(view({ oidc: set(OIDC) }));
    render(<SignInSection />);
    fireEvent.click(screen.getByTestId('server-oidc-remove'));
    await vi.waitFor(() => expect(clear).toHaveBeenCalledWith({ url: URL_, section: 'oidc' }));

    fireEvent.change(screen.getByTestId('server-saml-metadata'), { target: { value: ' <EntityDescriptor/> ' } });
    fireEvent.click(screen.getByTestId('server-saml-save'));
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        url: URL_,
        section: 'saml',
        value: { idpMetadataXml: '<EntityDescriptor/>' },
      }),
    );
    expect(screen.getByTestId('server-saml-email')).toBeTruthy();
    expect(screen.getByTestId('server-saml-name')).toBeTruthy();
    expect(screen.getByTestId('server-saml-skew')).toBeTruthy();
    expect(screen.getByTestId('server-saml-acs').textContent).toBe(`${URL_}/api/v1/auth/saml/acs`);
  });

  it('is read-only on a self-hosted server, naming each variable', () => {
    loaded(environment());
    render(<SignInSection />);
    const oidc = screen.getByTestId('server-oidc');
    expect(within(oidc).getByTestId('server-oidc-state').textContent).toBe('Set by the server’s environment');
    expect(oidc.textContent).toContain('WIREBENCH_SERVER_OIDC_ISSUER');
    expect(oidc.textContent).toContain('https://idp.corp.example');
    expect(oidc.querySelector('input')).toBeNull();
    expect(screen.queryByTestId('server-oidc-save')).toBeNull();
    const saml = screen.getByTestId('server-saml');
    expect(within(saml).getByTestId('server-saml-state').textContent).toBe('Not set');
    expect(saml.textContent).toContain('WIREBENCH_SERVER_SAML_IDP_METADATA');
  });

  it('requires two-step sign-in with one switch, and counts the people without a second step', async () => {
    const save = vi.fn().mockResolvedValue(ok(view({ twoFactor: set({ required: true }) })));
    const serverPeople = vi.fn().mockResolvedValue(
      ok({
        people: [
          { userId: 'a', password: true, twoFactor: false, disabled: false },
          { userId: 'b', password: true, twoFactor: true, disabled: false },
          { userId: 'c', password: false, twoFactor: false, disabled: false },
          { userId: 'd', password: true, twoFactor: false, disabled: true },
        ],
      }),
    );
    installWirebenchApi({ serverSettings: { save }, account: { serverPeople } });
    loaded(view());
    render(<SignInSection />);
    const card = screen.getByTestId('server-two-factor');
    expect(within(card).getByTestId('server-two-factor-state').textContent).toBe('Optional');
    expect((await screen.findByTestId('server-two-factor-missing')).textContent).toBe(
      '1 person with a password has no second step yet.',
    );
    fireEvent.click(screen.getByTestId('server-two-factor-required'));
    fireEvent.click(screen.getByTestId('server-two-factor-save'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ url: URL_, section: 'twoFactor', value: { required: true } });
  });

  it('a self-hosted server shows the requirement from its environment', () => {
    loaded(environment({ twoFactor: { source: 'environment', writable: false, value: { required: true } } }));
    render(<SignInSection />);
    const card = screen.getByTestId('server-two-factor');
    expect(card.textContent).toContain('WIREBENCH_SERVER_REQUIRE_TWO_FACTOR');
    expect(card.querySelector('input')).toBeNull();
  });
});

describe('Provisioning', () => {
  it('lists the SCIM tokens and shows a new one once', async () => {
    const token = { id: 't1', name: 'idp', createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt: null };
    const listTokens = vi
      .fn()
      .mockResolvedValueOnce(ok({ tokens: [] }))
      .mockResolvedValue(ok({ tokens: [token] }));
    const createToken = vi.fn().mockResolvedValue(ok({ ...token, token: 'wbscim_secret' }));
    installWirebenchApi({
      provisioning: {
        info: vi
          .fn()
          .mockResolvedValue(ok({ configured: false, entityId: 'e', acsUrl: 'a', scimBaseUrl: `${URL_}/scim/v2` })),
        listTokens,
        listGroups: vi.fn().mockResolvedValue(ok({ groups: [] })),
        createToken,
      },
    });
    loaded(view());
    render(<ProvisioningSection />);
    await vi.waitFor(() => expect(screen.getByTestId('server-scim-base').textContent).toBe(`${URL_}/scim/v2`));
    fireEvent.change(screen.getByTestId('server-scim-name'), { target: { value: 'idp' } });
    fireEvent.click(screen.getByTestId('server-scim-create'));
    await vi.waitFor(() =>
      expect(screen.getByTestId('server-scim-token-value')).toHaveProperty('value', 'wbscim_secret'),
    );
    expect(createToken).toHaveBeenCalledWith({ url: URL_, name: 'idp' });
    await vi.waitFor(() => expect(screen.getAllByTestId('server-scim-token')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('server-scim-created-done'));
    expect(screen.queryByTestId('server-scim-token-value')).toBeNull();
  });
});

describe('Audit forwarding', () => {
  it('refuses a URL that is not https, and keeps a stored token unless it is replaced', async () => {
    const save = vi.fn().mockResolvedValue(ok(view()));
    installWirebenchApi({ serverSettings: { save } });
    loaded(view({ auditForward: set({ url: 'https://siem.acme.example/in', token: { set: true } }) }));
    render(<AuditForwardingSection />);
    expect(screen.getByTestId('server-audit-forward-token-state').textContent).toBe('Set');
    fireEvent.change(screen.getByTestId('server-audit-forward-url'), { target: { value: 'http://siem.acme.example' } });
    fireEvent.click(screen.getByTestId('server-audit-forward-save'));
    expect(screen.getByTestId('server-audit-forward-error').textContent).toContain('https://');
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('server-audit-forward-url'), {
      target: { value: 'https://siem.acme.example/in' },
    });
    fireEvent.click(screen.getByTestId('server-audit-forward-save'));
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        url: URL_,
        section: 'auditForward',
        value: { url: 'https://siem.acme.example/in' },
      }),
    );
  });
});

describe('Email', () => {
  it('puts typed credentials into the SMTP URL, and sends the bare URL otherwise', async () => {
    expect(smtpUrl('smtps://smtp.acme.example:465', { username: 'mailer', password: 'p@ss' })).toBe(
      'smtps://mailer:p%40ss@smtp.acme.example:465',
    );
    const save = vi.fn().mockResolvedValue(ok(view()));
    installWirebenchApi({ serverSettings: { save } });
    loaded(
      view({
        smtp: set({ url: 'smtps://smtp.acme.example:465', from: 'wb@acme.example', credentials: { set: true } }),
      }),
    );
    render(<EmailSection />);
    expect(screen.getByTestId('server-smtp-credentials-state').textContent).toBe('Set');
    fireEvent.click(screen.getByTestId('server-smtp-save'));
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        url: URL_,
        section: 'smtp',
        value: { url: 'smtps://smtp.acme.example:465', from: 'wb@acme.example' },
      }),
    );
    fireEvent.click(screen.getByTestId('server-smtp-credentials-replace'));
    fireEvent.change(screen.getByTestId('server-smtp-username'), { target: { value: 'mailer' } });
    fireEvent.change(screen.getByTestId('server-smtp-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('server-smtp-save'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toMatchObject({ value: { url: 'smtps://mailer:pw@smtp.acme.example:465' } });
  });

  it('refuses a URL that is not smtp: or smtps:', () => {
    const save = vi.fn();
    installWirebenchApi({ serverSettings: { save } });
    loaded(view());
    render(<EmailSection />);
    fireEvent.change(screen.getByTestId('server-smtp-url'), { target: { value: 'https://mail.example' } });
    fireEvent.change(screen.getByTestId('server-smtp-sender'), { target: { value: 'a@b.example' } });
    fireEvent.click(screen.getByTestId('server-smtp-save'));
    expect(screen.getByTestId('server-smtp-error').textContent).toContain('smtp://');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('Retention', () => {
  it('sends only the ages typed, and refuses one out of range', async () => {
    const save = vi.fn().mockResolvedValue(ok(view()));
    installWirebenchApi({ serverSettings: { save } });
    loaded(view());
    render(<RetentionSection />);
    fireEvent.change(screen.getByTestId('server-retention-hooksMaxAgeDays'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('server-retention-save'));
    expect(screen.getByTestId('server-retention-error').textContent).toContain('Captured callbacks');
    fireEvent.change(screen.getByTestId('server-retention-hooksMaxAgeDays'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('server-retention-auditMaxAgeDays'), { target: { value: '365' } });
    fireEvent.click(screen.getByTestId('server-retention-save'));
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        url: URL_,
        section: 'retention',
        value: { auditMaxAgeDays: 365, hooksMaxAgeDays: 30 },
      }),
    );
  });

  it('shows a self-hosted server’s ages with their variables', () => {
    loaded(environment());
    render(<RetentionSection />);
    const card = screen.getByTestId('server-retention');
    expect(card.textContent).toContain('365 days');
    expect(card.textContent).toContain('WIREBENCH_SERVER_SESSION_LOG_MAX_MB');
    expect(card.querySelector('input')).toBeNull();
  });
});

describe('Billing', () => {
  it('shows the plan and seats, and a past-due banner with the days left', () => {
    loaded(view(), BILLING);
    render(<BillingSection />);
    expect(screen.getByTestId('server-billing-plan').textContent).toBe('Team');
    expect(screen.getByTestId('server-billing-seats').textContent).toBe('12 of 15 in use');
    expect(screen.getByTestId('server-billing-status').textContent).toBe(
      `Past due since ${formatDate('2026-11-04T10:00:00.000Z')}`,
    );
    expect(screen.getByTestId('server-billing-past-due').textContent).toContain('suspended in 11 days');
  });

  it('has no banner while the subscription is paid', () => {
    loaded(view(), {
      ...BILLING,
      subscription: { ...BILLING.subscription!, status: 'active', pastDueSince: null, pastDueDaysLeft: null },
    });
    render(<BillingSection />);
    expect(screen.queryByTestId('server-billing-past-due')).toBeNull();
    expect(screen.getByTestId('server-billing-status').textContent).toBe('Active');
  });
});

describe('Export', () => {
  const READY: TenantExportWire = {
    id: 'e1',
    status: 'ready',
    requestedBy: 'Dana Ruiz',
    sizeBytes: 48 * 1024 * 1024,
    sha256: null,
    error: null,
    requestedAt: '2026-11-05T09:12:00.000Z',
    readyAt: '2026-11-05T09:14:00.000Z',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 - 60_000).toISOString(),
  };
  const QUEUED: TenantExportWire = { ...READY, id: 'e2', status: 'queued', sizeBytes: null, expiresAt: null };

  it('lists the exports, asks for one, and saves a ready one through main', async () => {
    const list = vi.fn().mockResolvedValue(ok({ exports: [READY] }));
    const request = vi.fn().mockResolvedValue(ok({ export: QUEUED }));
    const download = vi.fn().mockResolvedValue(ok({ saved: true, path: '/tmp/x.tar.gz', sizeBytes: 5 }));
    installWirebenchApi({ tenantExports: { list, request, download } });
    loaded(view());
    render(<ExportSection />);
    await vi.waitFor(() => expect(screen.getAllByTestId('server-export-row')).toHaveLength(1));
    const row = screen.getByTestId('server-export-row');
    expect(row.textContent).toContain('Ready · expires in 7 days');
    expect(row.textContent).toContain('48 MB');
    expect(within(row).getByTestId('server-export-by').textContent).toBe('Dana Ruiz');
    fireEvent.click(within(row).getByTestId('server-export-download'));
    await vi.waitFor(() => expect(download).toHaveBeenCalledWith({ url: URL_, id: 'e1' }));

    fireEvent.click(screen.getByTestId('server-export-request'));
    await vi.waitFor(() => expect(screen.getAllByTestId('server-export-row')).toHaveLength(2));
    expect(request).toHaveBeenCalledWith({ url: URL_ });
    // One export runs at a time: no second request while one is queued.
    expect(screen.getByTestId('server-export-request')).toHaveProperty('disabled', true);
  });

  it('polls quietly: a download refusal stays, and nothing turns busy', async () => {
    const list = vi.fn().mockResolvedValue(ok({ exports: [READY, QUEUED] }));
    installWirebenchApi({ tenantExports: { list } });
    loaded(view());
    useServerSettingsStore.setState({ errors: { exports: 'Could not reach the server' } });
    const busy: boolean[] = [];
    const unsubscribe = useServerSettingsStore.subscribe((s) => busy.push(s.busy.exports === true));
    await useServerSettingsStore.getState().pollExports();
    unsubscribe();
    expect(list).toHaveBeenCalledWith({ url: URL_ });
    expect(useServerSettingsStore.getState().exports.map((row) => row.id)).toEqual(['e1', 'e2']);
    expect(useServerSettingsStore.getState().errors.exports).toBe('Could not reach the server');
    expect(busy.every((flag) => !flag)).toBe(true);
    // A failed poll changes nothing; the next one retries.
    list.mockResolvedValue({ ok: false, error: { code: 'server-unreachable', message: 'down' } });
    await useServerSettingsStore.getState().pollExports();
    expect(useServerSettingsStore.getState().exports).toHaveLength(2);
    expect(useServerSettingsStore.getState().errors.exports).toBe('Could not reach the server');
  });

  it('says why an export failed in plain words, never its code', async () => {
    const failed = (id: string, error: string | null): TenantExportWire => ({
      ...READY,
      id,
      status: 'failed',
      error,
      sizeBytes: null,
      readyAt: null,
      expiresAt: null,
    });
    installWirebenchApi({
      tenantExports: {
        list: vi
          .fn()
          .mockResolvedValue(
            ok({ exports: [failed('f1', 'ENOSPC'), failed('f2', 'some-new-code'), failed('f3', null)] }),
          ),
      },
    });
    loaded(view());
    render(<ExportSection />);
    await vi.waitFor(() => expect(screen.getAllByTestId('server-export-row')).toHaveLength(3));
    const [disk, unknown, none] = screen.getAllByTestId('server-export-row');
    expect(disk!.textContent).toContain('The server ran out of disk space.');
    expect(unknown!.textContent).toContain('The export could not be written.');
    expect(unknown!.textContent).not.toContain('some-new-code');
    expect(none!.textContent).toContain('The export could not be written.');
    expect(exportFailureText('export-interrupted')).toMatch(/^The server stopped/);
  });

  it('downloads from the tab’s own server in a browser, by id only', async () => {
    const api = installWirebenchApi({ tenantExports: { list: vi.fn().mockResolvedValue(ok({ exports: [READY] })) } });
    Object.defineProperty(api, 'env', {
      configurable: true,
      value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'] },
    });
    loaded(view());
    render(<ExportSection />);
    const link = await screen.findByTestId('server-export-download');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(`${URL_}/api/v1/tenant/exports/e1/file`);
  });
});

describe('Close this account (ruling 9)', () => {
  it('is the page id close-account, a hosted team’s only, named so it is not mistaken for deleting a team', () => {
    expect(serverPages(view())).toContain('close-account');
    expect(serverPages(view())).not.toContain('delete');
    expect(serverPages(environment())).not.toContain('close-account');
    installWirebenchApi();
    loaded(view(), BILLING);
    render(<ServerPage page="close-account" />);
    const page = screen.getByTestId('server-page-close-account');
    expect(page.querySelector('h1')?.textContent).toBe('Close this account');
    expect(page.textContent).toContain('Close Acme Ltd’s account and delete everything in it.');
  });
});

describe('Close this account', () => {
  it('asks for the deletion with the slug typed, after a confirmation', async () => {
    const deletion = {
      requestedAt: '2026-11-05T09:00:00.000Z',
      deletingAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    };
    const request = vi.fn().mockResolvedValue(ok({ deletion }));
    installWirebenchApi({
      tenantDeletion: { request },
      tenantBilling: { get: vi.fn().mockResolvedValue(ok({ ...BILLING, deletion })) },
    });
    loaded(view(), BILLING);
    render(<CloseAccountSection />);
    expect(screen.getByTestId('server-delete').textContent).toContain('Type acme-team to confirm');
    expect(screen.getByTestId('server-delete').textContent).toContain('secret of Acme Ltd is removed');
    expect(screen.getByTestId('server-delete-request')).toHaveProperty('disabled', true);
    // The address's first label is not the slug: it confirms nothing.
    fireEvent.change(screen.getByTestId('server-delete-slug'), { target: { value: 'acme' } });
    expect(screen.getByTestId('server-delete-request')).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByTestId('server-delete-slug'), { target: { value: 'acme-team' } });
    expect(screen.getByTestId('server-delete-request')).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByTestId('server-delete-request'));
    fireEvent.click(await screen.findByTestId('server-delete-confirm'));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ url: URL_, slug: 'acme-team' }));
    await vi.waitFor(() =>
      expect(screen.getByTestId('server-delete-pending').textContent).toContain('Acme Ltd is deleted on'),
    );
  });

  it('cancels a deletion asked for', async () => {
    const cancel = vi.fn().mockResolvedValue(ok({ cancelled: true }));
    installWirebenchApi({ tenantDeletion: { cancel } });
    loaded(view(), {
      ...BILLING,
      deletion: {
        requestedAt: '2026-11-05T09:00:00.000Z',
        deletingAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
    });
    render(<CloseAccountSection />);
    expect(screen.getByTestId('server-delete-card').textContent).toContain('In 3 days');
    fireEvent.click(screen.getByTestId('server-delete-cancel'));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ url: URL_ }));
    await vi.waitFor(() => expect(screen.getByTestId('server-delete-slug')).toBeTruthy());
  });
});
