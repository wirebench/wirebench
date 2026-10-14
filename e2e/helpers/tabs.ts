import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Selects a tab in the strip named `strip`, wherever it is: in the strip itself, or in the strip's
 * More menu when the strip is too narrow to show it.
 */
export async function selectTab(page: Page, strip: string, name: string | RegExp): Promise<void> {
  const tab = page.getByRole('tablist', { name: strip }).getByRole('tab', { name });
  const more = page.getByRole('button', { name: new RegExp(`more ${escapeRegExp(strip)}$`, 'i') });
  // Retried as a whole: a label can change under the spec (a badge arriving with the response),
  // and a tab can move between the strip and the menu as the window or its label changes.
  await expect(async () => {
    if ((await tab.count()) > 0) {
      await tab.click({ timeout: 2_000 });
      return;
    }
    await more.click({ timeout: 2_000 });
    const menu = page.getByRole('menu');
    await menu.waitFor({ timeout: 2_000 });
    const item = menu.getByRole('menuitemradio', { name });
    if ((await item.count()) === 0) {
      await page.keyboard.press('Escape');
      throw new Error(`No ${String(name)} tab in ${strip}`);
    }
    await item.click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * The selected tab named `name` in the strip named `strip`: the tab itself, or the strip's More
 * button when the tab is in its menu, which then shows the tab's label and badge.
 */
export function selectedTab(page: Page, strip: string, name: string | RegExp): Locator {
  const label = typeof name === 'string' ? `^${escapeRegExp(name)}` : name.source;
  return page
    .getByRole('tablist', { name: strip })
    .getByRole('tab', { name })
    .or(page.getByRole('button', { name: new RegExp(`${label}.*, more ${escapeRegExp(strip)}$`) }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
