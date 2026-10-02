import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LicenseBanner } from '../../src/renderer/features/team/license-banner.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

describe('LicenseBanner (licensing spec §3.8)', () => {
  afterEach(() => cleanup());

  it('shows the grace banner to whoever can read the license', async () => {
    installWirebenchApi({
      license: {
        get: ok({
          edition: 'team',
          status: 'grace',
          seats: { used: 7, limit: 50 },
          features: [],
          expiresAt: '2027-09-01T00:00:00Z',
          graceUntil: '2027-10-01T00:00:00.000Z',
        }),
      },
    });
    render(<LicenseBanner url="https://wb.test" />);
    expect((await screen.findByTestId('license-banner')).textContent).toContain(
      'Everything keeps working until 2027-10-01.',
    );
  });

  it('shows nothing to a member, whose read is refused', async () => {
    const get = vi.fn().mockResolvedValue({ ok: false, error: { code: 'identity-forbidden', message: 'x' } });
    installWirebenchApi({ license: { get } });
    render(<LicenseBanner url="https://wb.test" />);
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByTestId('license-banner')).toBeNull();
  });
});
