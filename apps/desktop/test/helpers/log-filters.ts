import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** Opens the HTTP Log's Filters menu, unless it is already open. */
export async function openLogFilters(): Promise<void> {
  if (screen.queryByRole('menu') === null) {
    await userEvent.click(screen.getByTestId('http-log-filters'));
  }
}

/** One choice in a group of the open Filters menu (Method, Status or Protocol). */
export function logFilterItem(group: string, name: string): HTMLElement {
  return within(screen.getByRole('group', { name: group })).getByRole('menuitemcheckbox', { name });
}

/** Opens the Filters menu and toggles one choice in it; the menu stays open. */
export async function toggleLogFilter(group: string, name: string): Promise<void> {
  await openLogFilters();
  await userEvent.click(within(screen.getByRole('group', { name: group })).getByRole('menuitemcheckbox', { name }));
}
