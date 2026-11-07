/**
 * Switch accounts in the browser client (switch accounts spec §5, §10), against the same stack and seed as
 * `team-settings.spec.ts`: sign in as the seeded user, *Add account* as the seed's plain account (its password comes
 * from the seed), see the first under *Switch accounts*, switch back, and sign the active one out, which leaves the
 * other active.
 *
 * It creates no account (each takes one of the five community seats): the second person is the seed's
 * `existingEmail`. The steps share one page, in order. Every page reports its CSP violations and the console its
 * errors; the last step asserts there were none.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readSeed, type Seed } from './stack.js';

test.describe.configure({ mode: 'serial' });

let seed: Seed;
let context: BrowserContext;
let page: Page;
const violations: string[] = [];
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  context = await browser.newContext();
  await context.exposeBinding('__wirebenchCspViolation', (_source, line: string) => {
    violations.push(line);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __wirebenchCspViolation: (line: string) => Promise<void> })
        .__wirebenchCspViolation;
      void report(
        `${event.violatedDirective} blocked ${event.blockedURI} at ${event.sourceFile}:${String(event.lineNumber)}`,
      );
    });
  });
  page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`${page.url()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`${page.url()}: uncaught ${error.message}`);
  });
});

test.afterAll(async () => {
  await context.close();
});

/** Fills the sign-in page, in either mode, and waits for the app to come back as `email`. */
async function fillSignIn(email: string, password: string): Promise<void> {
  await page.locator('#identifier').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
  await expectActive(email);
}

/** The account menu's trigger names the active account. */
async function expectActive(email: string): Promise<void> {
  await expect(page.getByTestId('status-bar-account')).toContainText(email, { timeout: 60_000 });
}

async function openMenu(): Promise<void> {
  await page.getByTestId('status-bar-account').click();
  await expect(page.getByTestId('status-bar-account-menu')).toBeVisible();
}

/** The *Switch accounts* row for `email`. */
function switchRow(email: string) {
  return page.getByTestId('status-bar-account-menu').locator('[data-testid^="account-switch-"]').filter({
    hasText: email,
  });
}

test('signs in as the seeded user, with nobody else to switch to', async () => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect_to=/);
  await fillSignIn(seed.email, seed.password);
  await openMenu();
  await expect(page.getByTestId('account-menu-header')).toContainText(seed.email);
  await expect(page.getByTestId('status-bar-account-menu')).toContainText('Switch accounts');
  await expect(page.locator('[data-testid^="account-switch-"]:not([data-testid*="avatar"])')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Add account signs the second person in without signing the first out', async () => {
  await openMenu();
  await page.getByTestId('account-add').click();
  await expect(page).toHaveURL(/\/sign-in\?add=1/);
  await expect(page.getByText('Add an account')).toBeVisible();
  await fillSignIn(seed.existingEmail, seed.existingPassword);

  await openMenu();
  await expect(page.getByTestId('account-menu-header')).toContainText(seed.existingEmail);
  await expect(switchRow(seed.email)).toHaveCount(1);
  await expect(switchRow(seed.email)).toContainText('Browser E2E');
  await page.keyboard.press('Escape');
});

test('switching reloads the tab as the first person, and the second is under Switch accounts', async () => {
  await openMenu();
  await switchRow(seed.email).click();
  await expectActive(seed.email);
  await openMenu();
  await expect(switchRow(seed.existingEmail)).toHaveCount(1);
  await expect(switchRow(seed.email)).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('signing the active account out keeps the other one signed in and active', async () => {
  await openMenu();
  await page.getByTestId('account-sign-out').click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
  await expectActive(seed.existingEmail);
  await openMenu();
  // The signed-out person is forgotten by the browser (spec ruling 2).
  await expect(switchRow(seed.email)).toHaveCount(0);
  await page.getByTestId('account-sign-out').click();
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 60_000 });
});

test('no page broke its CSP or logged an error along the way', () => {
  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
