import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeaturesSection } from '../../src/renderer/features/preferences/sections/features-section.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { AppFeaturesWire, PreferencesPatchWire, PreferencesWire } from '@wirebench/wire/wire-base';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/** The rows main resolved: gRPC off by preference, webhooks off through REST, MCP experimental. */
const ANSWER: AppFeaturesWire = {
  states: [
    { id: 'soap', title: 'SOAP', stage: 'stable', requires: [], default: true, policy: false, enabled: true },
    {
      id: 'rest',
      title: 'REST',
      stage: 'stable',
      requires: [],
      default: true,
      policy: true,
      enabled: false,
      reason: { by: 'policy' },
    },
    {
      id: 'grpc',
      title: 'gRPC',
      stage: 'stable',
      requires: [],
      default: true,
      preference: false,
      policy: false,
      enabled: false,
      reason: { by: 'preference' },
    },
    {
      id: 'mcp',
      title: 'MCP requests',
      stage: 'experimental',
      requires: [],
      default: true,
      policy: false,
      enabled: true,
    },
    {
      id: 'webhooks',
      title: 'Webhooks',
      stage: 'stable',
      requires: ['rest'],
      default: true,
      policy: false,
      enabled: false,
      reason: { by: 'requires', feature: 'rest' },
    },
  ],
  policy: { workspace: 'Payments', disabled: ['rest'] },
};

function renderSection(preferences: PreferencesWire, update = vi.fn<(patch: PreferencesPatchWire) => void>()) {
  render(<FeaturesSection preferences={preferences} update={update} />);
  return update;
}

beforeEach(() => {
  installWirebenchApi({ app: { features: vi.fn().mockResolvedValue({ ok: true, value: ANSWER }) } });
});

afterEach(() => {
  cleanup();
});

describe('Settings → Features (phase 4 spec §4.3)', () => {
  it('lists the rows in their groups, with the stage badge and the reasons', async () => {
    renderSection({ ...DEFAULT_PREFERENCES_WIRE, features: { grpc: false } });
    await screen.findByTestId('feature-switch-soap');
    // Rendered outside the Settings page's card provider, the row is the compact checkbox.
    expect(screen.getByTestId<HTMLInputElement>('feature-switch-grpc').checked).toBe(false);
    expect(screen.getByTestId('feature-stage-mcp').textContent).toContain('Experimental');
    expect(screen.getByTestId('feature-note-rest').textContent).toContain('Off by team policy for Payments');
    expect(screen.getByTestId<HTMLInputElement>('feature-switch-rest').disabled).toBe(true);
    expect(screen.getByTestId('feature-note-webhooks').textContent).toContain('Requires REST');
    expect(screen.queryByTestId('feature-note-soap')).toBeNull();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Protocols', 'Automation']);
  });

  it('patches the preference on a toggle and says it applies after a restart', async () => {
    const update = renderSection(DEFAULT_PREFERENCES_WIRE);
    const soap = await screen.findByTestId('feature-switch-soap');
    fireEvent.click(soap);
    expect(update).toHaveBeenCalledWith({ features: { soap: false } });

    // The document the store holds after the patch: the row shows the pending change.
    cleanup();
    renderSection({ ...DEFAULT_PREFERENCES_WIRE, features: { soap: false } });
    await waitFor(() => {
      expect(screen.getByTestId('feature-note-soap').textContent).toContain('Applies after restart');
    });
    // gRPC was off at start and is off in the file: nothing pending.
    cleanup();
    renderSection({ ...DEFAULT_PREFERENCES_WIRE, features: { grpc: false } });
    await screen.findByTestId('feature-switch-grpc');
    expect(screen.queryByTestId('feature-note-grpc')).toBeNull();
  });
});
