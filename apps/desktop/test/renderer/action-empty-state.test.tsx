import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Box } from 'lucide-react';
import { ActionEmptyState } from '../../src/renderer/components/empty-state.js';
import { SshEmptyState } from '../../src/renderer/features/ssh/ssh-view-frame.js';

describe('ActionEmptyState', () => {
  afterEach(cleanup);

  it('says what the place is for and tabs through its actions in order, primary first', async () => {
    render(
      <ActionEmptyState icon={Box} text="Add the first one." testId="the-card">
        <button type="button">First</button>
        <button type="button">Second</button>
      </ActionEmptyState>,
    );
    expect(screen.getByTestId('the-card').textContent).toContain('Add the first one.');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second' }));
  });

  it('defaults its test id, and the SSH views keep their own', () => {
    render(
      <>
        <ActionEmptyState icon={Box} text="Shared.">
          <button type="button">A</button>
        </ActionEmptyState>
        <SshEmptyState icon={Box} text="SSH.">
          <button type="button">B</button>
        </SshEmptyState>
      </>,
    );
    expect(screen.getByTestId('empty-state').textContent).toContain('Shared.');
    expect(screen.getByTestId('ssh-empty-state').textContent).toContain('SSH.');
  });
});
