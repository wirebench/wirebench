import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  type ReadStream,
  type WriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { openAdvanced, showSshNav } from '../helpers/ssh-host.js';

/** Whether socat is installed here: CI's Linux runner installs it to make a virtual serial line; elsewhere this skips. */
function socatInstalled(): boolean {
  if (process.platform === 'win32') return false;
  try {
    execFileSync('sh', ['-c', 'command -v socat'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let launched: LaunchedApp | undefined;
let socat: ChildProcess | undefined;
let device: WriteStream | undefined;
let reader: ReadStream | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    reader?.destroy();
    device?.destroy();
    socat?.kill();
    launched = undefined;
    reader = undefined;
    socat = undefined;
    device = undefined;
  }
});

test.skip(!socatInstalled(), 'socat is not installed on this machine');

test('a serial console asks for its port on this computer, then talks over the line (#426)', async () => {
  test.setTimeout(120_000);
  // Two linked pseudo-terminals: Wirebench opens one end as its serial port, the test plays the device on the other.
  const dir = mkdtempSync(join(tmpdir(), 'wb-serial-'));
  const port = join(dir, 'ttyWB0');
  const end = join(dir, 'ttyDEV0');
  socat = spawn('socat', [`pty,raw,echo=0,link=${port}`, `pty,raw,echo=0,link=${end}`], { stdio: 'ignore' });
  await expect.poll(() => existsSync(port) && existsSync(end), { timeout: 10_000 }).toBe(true);
  device = createWriteStream(end, { flags: 'r+' });
  reader = createReadStream(end);
  // The line going away with socat at the end reads as EIO: the test is over by then.
  device.on('error', () => undefined);
  reader.on('error', () => undefined);
  const replies = device;
  let line = '';
  reader.on('data', (chunk: Buffer | string) => {
    for (const ch of chunk.toString()) {
      if (ch === '\r') {
        replies.write(`\r\nyou said: ${line}\r\nrouter> `);
        line = '';
      } else {
        line += ch;
        replies.write(ch);
      }
    }
  });

  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Lab');
  await showSshNav(page, 'hosts');
  await page.getByRole('button', { name: 'New host' }).click();
  const dialog = page.getByTestId('host-dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('router console');
  await openAdvanced(dialog);
  await dialog
    .getByRole('region', { name: 'Protocol' })
    .getByRole('combobox', { name: 'Protocol' })
    .selectOption('serial');
  await expect(dialog.getByLabel('Address', { exact: true })).toBeHidden();
  await dialog.getByLabel('Baud', { exact: true }).fill('9600');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // No device picked on this computer yet: the connection screen asks for one.
  await page.getByTestId('host-row-router-console').dblclick();
  const picker = page.getByTestId('connect-serial-device');
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await picker.getByLabel('Serial port path').fill(port);
  await picker.getByRole('button', { name: 'Use and connect' }).click();

  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const terminal = page.getByTestId('ssh-terminal');
  await terminal.click();
  await page.keyboard.type('show version');
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('you said: show version', { timeout: 30_000 });
});
