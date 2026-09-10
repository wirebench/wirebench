import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthFields } from '../../src/renderer/components/auth-fields.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { EndpointAuthWire } from '../../src/shared/wire-types.js';

afterEach(() => {
  cleanup();
});

describe('AuthFields', () => {
  it('clearing the password drops passwordRef entirely rather than setting it to undefined', () => {
    installWirebenchApi();
    const onChange = vi.fn();
    const auth: EndpointAuthWire = { type: 'basic', username: 'ada', passwordRef: 'ref-old' };
    render(<AuthFields scope="Endpoint" auth={auth} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const sent = onChange.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('passwordRef' in sent).toBe(false);
    expect(sent).toEqual({ type: 'basic', username: 'ada' });
  });

  it('flushes an unsaved-but-typed password on unmount', async () => {
    installWirebenchApi({ secrets: { set: vi.fn().mockResolvedValue({ ok: true, value: { ref: 'ref-flushed' } }) } });
    const onChange = vi.fn();
    const auth: EndpointAuthWire = { type: 'basic', username: 'ada' };
    const { unmount } = render(<AuthFields scope="Endpoint" auth={auth} onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: 'Set…' }));
    await userEvent.type(screen.getByLabelText('Endpoint password'), 'hunter2');
    unmount();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ type: 'basic', username: 'ada', passwordRef: 'ref-flushed' });
    });
  });
});
