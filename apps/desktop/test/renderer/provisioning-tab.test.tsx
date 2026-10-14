import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProvisioningTab } from '../../src/renderer/features/team/provisioning-tab.js';
import { useProvisioningStore } from '../../src/renderer/state/provisioning.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const URL_ = 'https://wb.test';
const INFO = {
  configured: true,
  idpEntityId: 'https://idp.example.test/saml',
  entityId: `${URL_}/api/v1/auth/saml/metadata`,
  acsUrl: `${URL_}/api/v1/auth/saml/acs`,
  scimBaseUrl: `${URL_}/scim/v2`,
};
const TOKEN = { id: 'T1', name: 'Entra ID', createdAt: '2026-10-13T10:00:00.000Z', lastUsedAt: null };
const GROUP = { id: 'G1', displayName: 'Engineering', memberCount: 2, team: null };
const TEAMS = [
  { id: 'M1', name: 'Payments' },
  { id: 'M2', name: 'Platform' },
];
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const fail = (code: string, message: string) => vi.fn().mockResolvedValue({ ok: false, error: { code, message } });

function install(overrides: Record<string, unknown> = {}) {
  return installWirebenchApi({
    provisioning: {
      info: ok(INFO),
      listTokens: ok({ tokens: [TOKEN] }),
      listGroups: ok({ groups: [GROUP] }),
      createToken: ok({ ...TOKEN, id: 'T2', name: 'Okta', token: `wbscim_${'A'.repeat(43)}` }),
      revokeToken: ok({ revoked: true }),
      linkGroup: ok({ ...GROUP, team: TEAMS[0] }),
      ...overrides,
    },
  });
}

describe('ProvisioningTab (saml-scim spec §3.7)', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    useProvisioningStore.getState().reset();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => cleanup());

  it('shows only the Enterprise note without the feature', async () => {
    install({ info: fail('licensing-feature-required', 'Enterprise only.') });
    render(<ProvisioningTab url={URL_} teams={TEAMS} />);
    expect(await screen.findByTestId('provisioning-gated')).toBeTruthy();
    expect(screen.queryByTestId('provisioning-tokens')).toBeNull();
  });

  it('shows the SCIM base URL and the SAML details, each copyable', async () => {
    install();
    render(<ProvisioningTab url={URL_} teams={TEAMS} />);
    expect((await screen.findByTestId('provisioning-scim-url')).textContent).toBe(INFO.scimBaseUrl);
    expect(screen.getByTestId('provisioning-saml-configured').textContent).toBe('Configured');
    expect(screen.getByTestId('provisioning-idp-entity-id').textContent).toBe(INFO.idpEntityId);
    fireEvent.click(screen.getByTestId('provisioning-acs-url-copy'));
    expect(writeText).toHaveBeenCalledWith(INFO.acsUrl);
    fireEvent.click(screen.getByTestId('provisioning-entity-id-copy'));
    expect(writeText).toHaveBeenCalledWith(INFO.entityId);
  });

  it('creates a token, shows it once with a copy, and clears it on Done', async () => {
    const api = install();
    render(<ProvisioningTab url={URL_} teams={TEAMS} />);
    await screen.findByTestId('provisioning-token-T1');
    fireEvent.change(screen.getByTestId('provisioning-token-name'), { target: { value: ' Okta ' } });
    fireEvent.click(screen.getByTestId('provisioning-token-create'));
    const field = await screen.findByTestId<HTMLInputElement>('provisioning-created-token');
    expect(field.value).toMatch(/^wbscim_/);
    expect(api.provisioning.createToken).toHaveBeenCalledWith({ url: URL_, name: 'Okta' });
    fireEvent.click(screen.getByTestId('provisioning-created-copy'));
    expect(writeText).toHaveBeenCalledWith(field.value);
    fireEvent.click(screen.getByTestId('provisioning-created-done'));
    expect(screen.queryByTestId('provisioning-created-token')).toBeNull();
    expect(useProvisioningStore.getState().created).toBeUndefined();
  });

  it('revokes behind a confirmation', async () => {
    const api = install();
    render(<ProvisioningTab url={URL_} teams={TEAMS} />);
    fireEvent.click(await screen.findByTestId('provisioning-revoke-T1'));
    expect(api.provisioning.revokeToken).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('provisioning-revoke-confirm-button'));
    await waitFor(() => expect(api.provisioning.revokeToken).toHaveBeenCalledWith({ url: URL_, tokenId: 'T1' }));
  });

  it('links a group to a team, unlinks with Not linked, and shows a refusal on the row', async () => {
    const linkGroup = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { ...GROUP, team: TEAMS[0] } })
      .mockResolvedValueOnce({ ok: true, value: GROUP })
      .mockResolvedValueOnce({ ok: false, error: { code: 'teams-not-found', message: 'That team was not found.' } });
    install({ linkGroup });
    render(<ProvisioningTab url={URL_} teams={TEAMS} />);
    const picker = await screen.findByTestId<HTMLSelectElement>('provisioning-group-team-G1');
    expect(screen.getByTestId('provisioning-group-G1').textContent).toContain('2 members');
    fireEvent.change(picker, { target: { value: 'M1' } });
    await waitFor(() => expect(picker.value).toBe('M1'));
    expect(linkGroup).toHaveBeenLastCalledWith({ url: URL_, groupId: 'G1', teamId: 'M1' });
    fireEvent.change(picker, { target: { value: '' } });
    await waitFor(() => expect(linkGroup).toHaveBeenLastCalledWith({ url: URL_, groupId: 'G1', teamId: null }));
    fireEvent.change(picker, { target: { value: 'M2' } });
    expect((await screen.findByTestId('provisioning-group-error-G1')).textContent).toBe('That team was not found.');
  });

  it('Refresh reloads', async () => {
    const api = install();
    render(<ProvisioningTab url={URL_} teams={TEAMS} />);
    await screen.findByTestId('provisioning-token-T1');
    fireEvent.click(screen.getByTestId('provisioning-refresh'));
    await waitFor(() => expect(api.provisioning.listGroups).toHaveBeenCalledTimes(2));
  });
});
