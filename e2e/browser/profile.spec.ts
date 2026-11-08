/**
 * The user profile in the browser client (user profile spec §10), against the same stack and seed as
 * `team-settings.spec.ts`: set a username on Profile, sign out and sign in with it; upload a photo through the crop
 * dialog and see it in the account menu and on People; open the seeded team mate's card.
 *
 * It creates no account (each takes one of the five community seats) and renames no one: the team mate is the
 * seed's `existingEmail`, an admin of the second team beside the seeded user. The steps share one page, in order.
 * Every page reports its CSP violations and the console its errors; the last step asserts there were none.
 */
import { deflateSync } from 'node:zlib';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { runCommand } from '../helpers/palette.js';
import { readSeed, type Seed } from './stack.js';

test.describe.configure({ mode: 'serial' });

let seed: Seed;
let context: BrowserContext;
let page: Page;
const violations: string[] = [];
const consoleErrors: string[] = [];
/** Made per run (3–30 of `a–z 0–9 . _ -`), so a rerun against a stack still up sets a new one. */
const username = `e2e-${Date.now().toString(36)}`;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A small valid PNG (RGB, two-colour diagonal), made here so the suite carries no image file. */
function makePng(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const rows: number[] = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(0); // filter: none
    for (let x = 0; x < size; x += 1) rows.push(...(x > y ? [0xd9, 0x6c, 0x3f] : [0x2b, 0x4c, 0x7e]));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

  await signIn(seed.email);
});

test.afterAll(async () => {
  await context.close();
});

async function signIn(identifier: string): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\?redirect_to=/);
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('workspace-open-team')).toBeVisible({ timeout: 60_000 });
}

async function openProfile(): Promise<Locator> {
  await runCommand(page, 'Account: Account settings');
  const user = page.getByTestId('user-settings');
  await expect(user).toBeVisible({ timeout: 20_000 });
  await expect(user.getByTestId('user-profile-email')).toHaveValue(seed.email);
  return user;
}

function settings(): Locator {
  return page.getByTestId('team-settings');
}

function memberRow(email: string): Locator {
  return settings().locator('[data-testid^="member-row-"]').filter({ hasText: email });
}

test('a username set on Profile is kept', async () => {
  const user = await openProfile();
  await expect(user.getByText('Sign in with this or your email.')).toBeVisible();
  const field = user.getByTestId('user-profile-username');
  await field.fill(username.toUpperCase());
  await field.press('Enter');
  await expect(user.getByTestId('user-profile-username-error')).toHaveCount(0);
  // The server stores it lower-cased, and the field shows what it stored.
  await expect(field).toHaveValue(username);
  await page.keyboard.press('Escape');
  await expect(user).toHaveCount(0);
});

test('signing out and in again with the username works', async () => {
  await page.getByTestId('status-bar-account').click();
  await page.getByTestId('account-sign-out').click();
  await expect(page).toHaveURL(/\/sign-in(\?redirect_to=%2F)?$/);
  await expect(page.locator('#identifier')).toBeVisible();
  await signIn(username);
  const user = await openProfile();
  await expect(user.getByTestId('user-profile-username')).toHaveValue(username);
});

test('a photo uploaded through the crop dialog shows on Profile and in the account menu', async () => {
  const user = page.getByTestId('user-settings');
  await expect(user.locator('span[data-testid="user-profile-photo"]')).toBeVisible();
  await user.getByTestId('user-profile-photo-input').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: makePng(64),
  });
  const dialog = page.getByTestId('crop-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('crop-save').click();
  await expect(dialog).toBeHidden();
  await expect(user.locator('img[data-testid="user-profile-photo"]')).toBeVisible();
  await expect(user.getByTestId('user-profile-photo-remove')).toBeVisible();
  await expect(user.getByTestId('user-profile-photo-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(user).toHaveCount(0);

  await expect(page.locator('img[data-testid="status-bar-account-avatar"]')).toBeVisible();
  await page.getByTestId('status-bar-account').click();
  await expect(page.getByTestId('account-menu-header')).toContainText(`@${username}`);
  await expect(page.locator('img[data-testid="account-menu-avatar"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('account-menu-header')).toHaveCount(0);
});

test('People shows the photo, and a team mate’s card opens from their name', async () => {
  await page.goto(`/?panel=team&team=${seed.secondTeamId}&page=people`);
  await expect(settings()).toBeVisible({ timeout: 60_000 });
  await expect(settings().getByTestId('team-switcher')).toContainText(seed.secondTeamName);
  const mine = memberRow(seed.email);
  await expect(mine).toContainText(`@${username}`);
  await expect(mine.locator('img[data-avatar="photo"]')).toBeVisible();

  await memberRow(seed.existingEmail).locator('[data-testid^="member-name-"]').click();
  const card = page.getByTestId('profile-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('profile-card-name')).toHaveText('Existing Person');
  await expect(card.getByTestId('profile-card-email')).toHaveText(seed.existingEmail);
  await expect(card.getByTestId('profile-card-role')).toHaveText('Admin');
  await expect(card.getByTestId('profile-card-error')).toHaveCount(0);
  await card.getByTestId('profile-card-close').click();
  await expect(card).toBeHidden();
});

test('no page broke its CSP or logged an error along the way', () => {
  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
