/**
 * Two-step sign-in in the browser client (two-step sign-in spec §4.1, §5) against the real server: the seeded plain
 * account sets up an authenticator on User settings → Password (the code computed here from the key the page shows),
 * saves its recovery codes, and adds a passkey through Chromium's virtual authenticator. It then signs out and back
 * in three times: with an authenticator code, with a recovery code, and with the passkey. Every page reports its CSP
 * violations; the last step asserts there were none.
 *
 * The steps share one page in order, and this file runs after the others (one worker, file order), so the account's
 * second step never meets another spec's sign-in. The required switch is the environment's on this self-hosted stack;
 * the server's and the renderer's tests cover it.
 */
import { createHmac } from 'node:crypto';
import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { readSeed, type Seed } from './stack.js';

test.describe.configure({ mode: 'serial' });

let seed: Seed;
let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
let key = '';
let codes: string[] = [];
const violations: string[] = [];

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 6238 with the server's parameters (SHA-1, 6 digits, 30 s), `offset` steps from now. */
function totp(base32: string, offset = 0): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of base32.replace(/\s+/g, '')) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const at = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
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
      void report(`${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });
  page = await context.newPage();
  // A passkey that needs no person: Chromium's virtual authenticator answers every ceremony at once.
  cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
});

test.afterAll(async () => {
  await context.close();
});

async function passwordStep(): Promise<void> {
  await page.goto('/sign-in');
  await page.locator('#identifier').fill(seed.existingEmail);
  await page.locator('#password').fill(seed.existingPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function signOut(): Promise<void> {
  await page.getByTestId('status-bar-account').click();
  await page.getByTestId('account-sign-out').click();
  await expect(page).toHaveURL(/\/sign-in(\?redirect_to=%2F)?$/);
}

async function signedIn(): Promise<void> {
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByTestId('status-bar-account')).toBeVisible({ timeout: 60_000 });
}

/** Answers the password the change asks for first. */
async function withPassword(): Promise<void> {
  await page.getByTestId('two-factor-password').fill(seed.existingPassword);
  await page.getByTestId('two-factor-prompt-confirm').click();
}

test('a person without two-step sign-in signs in with the password alone', async () => {
  await passwordStep();
  await signedIn();
});

test('sets up an authenticator on the Password page, and sees the recovery codes once', async () => {
  await page.goto('/?panel=user&page=password');
  await expect(page.getByTestId('two-factor-status')).toHaveText('Off', { timeout: 30_000 });
  await page.getByTestId('two-factor-totp-setup').click();
  await withPassword();
  await expect(page.getByTestId('two-factor-qr')).toBeVisible();
  key = ((await page.getByTestId('two-factor-key').textContent()) ?? '').replace(/\s+/g, '');
  expect(key).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByTestId('two-factor-totp-code').fill(totp(key));
  await page.getByTestId('two-factor-totp-verify').click();
  const list = page.getByTestId('recovery-codes-list').locator('li');
  await expect(list).toHaveCount(10);
  codes = await list.allTextContents();
  await page.getByTestId('recovery-codes-saved').click();
  await expect(page.getByTestId('two-factor-status')).toHaveText('On');
  await expect(page.getByTestId('two-factor-codes-left')).toHaveText('10 of 10 left');
});

test('adds a passkey in the page', async () => {
  await page.getByTestId('two-factor-passkey-add').click();
  await withPassword();
  await expect(page.getByTestId('two-factor-passkeys').locator('li')).toHaveCount(1, { timeout: 30_000 });
});

test('signs in with an authenticator code after the password', async () => {
  await signOut();
  await passwordStep();
  await expect(page.getByRole('heading', { name: 'Two-step sign-in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
  // The setup used this step's code: the next one is the one that still counts.
  await page.locator('#code').fill(totp(key, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await signedIn();
});

test('signs in with a recovery code instead', async () => {
  await signOut();
  await passwordStep();
  await page.getByText('Use a recovery code instead').click();
  await page.locator('#recovery').fill(codes[0]!);
  await page.getByRole('button', { name: 'Use recovery code' }).click();
  await signedIn();
});

test('signs in with the passkey', async () => {
  await signOut();
  await passwordStep();
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await signedIn();
});

test('no page broke its content security policy', () => {
  expect(violations).toEqual([]);
});
