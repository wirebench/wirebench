/** Drives a History row's ⋯ menu, where its Re-send, Compare and Delete actions live. */
import { fireEvent, screen, within } from '@testing-library/react';

/** Opens the ⋯ menu of the row named `requestName` and returns the menu. */
export async function openRowMenu(requestName: string): Promise<HTMLElement> {
  fireEvent.keyDown(screen.getByRole('button', { name: `Actions for ${requestName}` }), { key: 'Enter' });
  return screen.findByRole('menu');
}

/** Picks `action` from the ⋯ menu of the row named `requestName`. */
export async function chooseRowAction(requestName: string, action: string): Promise<void> {
  const menu = await openRowMenu(requestName);
  fireEvent.click(within(menu).getByRole('menuitem', { name: action }));
}

/** The names of the actions the row named `requestName` offers, closing its menu again. */
export async function rowActions(requestName: string): Promise<string[]> {
  const menu = await openRowMenu(requestName);
  const names = within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '');
  fireEvent.keyDown(menu, { key: 'Escape' });
  return names;
}
