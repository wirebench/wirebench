import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const secretNames = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { secretNames, setSecret: vi.fn() } }),
}));
import { HostAuthSection } from '../../src/renderer/features/ssh/host-auth-section.js';

const NAMES = ['deploy', 'deploy_cert', 'other'].map((name) => ({ name, local: true, external: false }));
afterEach(cleanup);

describe('HostAuthSection certificates (#421)', () => {
  it('picking a key takes its <key>_cert along, and the certificate can be cleared', async () => {
    secretNames.mockResolvedValue({ ok: true, value: { names: NAMES } });
    const onChange = vi.fn();
    const { rerender } = render(
      <HostAuthSection
        value={{ kind: 'key', secret: '' }}
        inherited={{ value: undefined, from: 'default' }}
        onChange={onChange}
      />,
    );
    await screen.findAllByRole('option', { name: 'deploy_cert' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Private key secret' }), 'deploy');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'key', secret: 'deploy', certificateSecret: 'deploy_cert' });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Private key secret' }), 'other');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'key', secret: 'other' });

    rerender(
      <HostAuthSection
        value={{ kind: 'key', secret: 'deploy', certificateSecret: 'deploy_cert' }}
        inherited={{ value: undefined, from: 'default' }}
        onChange={onChange}
      />,
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Certificate secret' }), '');
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'key', secret: 'deploy' });
  });
});
