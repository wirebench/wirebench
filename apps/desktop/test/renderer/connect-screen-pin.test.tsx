import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectScreen } from '../../src/renderer/features/ssh/connect-screen.js';
import { failedView, startView } from '../../src/renderer/features/ssh/connect-progress.js';

afterEach(cleanup);

const failed = (details: Record<string, unknown>) =>
  failedView(startView('a1', 'terminal', 1000), { code: 'ssh-sk-pin', message: 'x', details }, 1100);

const screenWith = (view: ReturnType<typeof failed>, onPin?: (pin: string) => void) =>
  render(
    <ConnectScreen
      hostId="web"
      purpose="terminal"
      view={view}
      onRetry={vi.fn()}
      onPin={onPin}
      onEditHost={vi.fn()}
      onClose={vi.fn()}
    />,
  );

describe('the connection screen asks for a security key PIN (#420)', () => {
  it('takes the PIN (at least 4 characters) and hands it to the next connect', async () => {
    const onPin = vi.fn();
    screenWith(failed({ reason: 'required' }), onPin);
    const field = screen.getByLabelText('Security key PIN');
    const unlock = screen.getByRole('button', { name: 'Unlock and connect' });
    await userEvent.type(field, '246');
    expect(unlock).toHaveProperty('disabled', true);
    await userEvent.type(field, '8{Enter}');
    expect(onPin).toHaveBeenCalledWith('2468');
  });

  it('says to try again after a wrong PIN', () => {
    screenWith(failed({ reason: 'wrong', retries: 6 }), vi.fn());
    expect(screen.getByLabelText('Try the security key PIN again')).toBeDefined();
    expect(screen.getByTestId('connect-error').textContent).toContain('6 attempts left');
  });

  it('shows no field for a locked key, or where the caller cannot connect again with a PIN', () => {
    screenWith(failed({ reason: 'blocked' }), vi.fn());
    expect(screen.queryByTestId('connect-pin')).toBeNull();
    cleanup();
    screenWith(failed({ reason: 'required' }));
    expect(screen.queryByTestId('connect-pin')).toBeNull();
  });
});
