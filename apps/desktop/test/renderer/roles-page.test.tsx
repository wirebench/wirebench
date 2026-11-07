import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RolesPage } from '../../src/renderer/features/team/settings/roles-page.js';
import { WORKSPACE_ABILITIES } from '../../src/renderer/features/team/roles.js';

describe('Team settings › What roles can do (settings split spec §3.4)', () => {
  afterEach(() => {
    cleanup();
  });

  it('one row per ability; the Viewer column checks only read and send', () => {
    render(<RolesPage />);
    const table = screen.getByTestId('roles-table');
    expect([...table.querySelectorAll('tbody tr')].map((row) => row.getAttribute('data-ability'))).toEqual([
      ...WORKSPACE_ABILITIES,
    ]);
    const allowed = (role: string) =>
      WORKSPACE_ABILITIES.filter(
        (ability) => screen.getByTestId(`roles-cell-${ability}-${role}`).getAttribute('data-allowed') === 'true',
      );
    expect(allowed('viewer')).toEqual(['read', 'send']);
    expect(allowed('editor')).toEqual(['read', 'send', 'edit']);
    expect(allowed('admin')).toEqual([...WORKSPACE_ABILITIES]);
    expect(screen.getByTestId('roles-page').textContent).toContain('Manage people: team admins.');
    expect(screen.getByTestId('roles-page').textContent).toContain(
      'Server admins are Admin on every workspace and manage every team.',
    );
  });
});
