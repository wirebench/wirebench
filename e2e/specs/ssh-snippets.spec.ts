import { expect, test, type Locator, type Page } from '@playwright/test';
import { startSshFixture, type SshFixture } from '@wirebench/ssh/test-helpers';
import { setMonacoText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createWorkspace } from '../helpers/project.js';
import { addPasswordHost, showSshNav, trustHostKey } from '../helpers/ssh-host.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** Long and unusual, so the page can only hold it if the value itself leaked. */
const SECRET = 'tok-7Hq2-Zp9w-e2e';

let launched: LaunchedApp | undefined;
let fixture: SshFixture | undefined;

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await fixture?.close();
    launched = undefined;
    fixture = undefined;
  }
});

/** The terminal of the tab in front (other terminal tabs stay mounted, hidden). */
function frontTerminal(page: Page): Locator {
  return page.locator('[data-testid="ssh-terminal"]:visible');
}

/** Brings the terminal tab of `host` to the front and waits for its session. */
async function showTerminalOf(page: Page, host: string): Promise<Locator> {
  await page.getByRole('tab', { name: new RegExp(host) }).click();
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  return frontTerminal(page);
}

async function showSnippets(page: Page): Promise<void> {
  await showSshNav(page, 'snippets');
}

/** The row of the snippet named `name` in the Snippets view. */
function snippetRow(page: Page, name: string): Locator {
  return page.locator('[data-snippet-id]').filter({ hasText: name });
}

test('snippets: create, run with a variable, mask a secret, palette, picker, ghost, two hosts', async () => {
  test.setTimeout(300_000);
  fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' } });
  launched = await launchApp();
  const page = launched.window;
  await createWorkspace(page, 'Snippets');
  await addPasswordHost(page, fixture, { name: 'alpha' });
  await addPasswordHost(page, fixture, { name: 'beta' });

  await page.getByTestId('host-row-alpha').dblclick();
  await trustHostKey(page, fixture);
  await expect(page.getByTestId('editor-area').getByLabel('connected', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // A package, then a snippet in it with a declared variable.
  await showSnippets(page);
  await page.getByRole('button', { name: 'More ways to add' }).click();
  await page.getByRole('menuitem', { name: 'New package' }).click();
  await page.getByLabel('Package name', { exact: true }).fill('Ops');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Ops' })).toBeVisible();

  await page.getByTestId('ssh-view-header').getByRole('button', { name: 'New snippet', exact: true }).click();
  const editor = page.getByTestId('snippet-editor');
  await editor.getByLabel('Name', { exact: true }).fill('Greet');
  await editor.getByLabel('Package', { exact: true }).selectOption({ label: 'Ops' });
  await setMonacoText(page, 'Script', 'echo hello-${who}');
  await editor.getByRole('button', { name: 'Declare ${who} as a variable' }).click();
  await editor.getByLabel('Default of who', { exact: true }).fill('world');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(snippetRow(page, 'Greet')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ops' }).getByTestId('snippet-section-count')).toHaveText('1');

  // No terminal is in front, so Run opens the dialog with the open terminal ticked and the variable asked for.
  await snippetRow(page, 'Greet').hover();
  await page.getByRole('button', { name: 'Run Greet' }).click();
  let dialog = page.getByTestId('snippet-run-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'alpha' })).toBeChecked();
  await expect(dialog.getByLabel('who', { exact: true })).toHaveValue('world');
  await dialog.getByLabel('who', { exact: true }).fill('snippets');
  await expect(dialog.getByTestId('snippet-run-preview')).toHaveText('echo hello-snippets');
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog).toBeHidden();
  // The fixture's shell echoes what it is sent, so the terminal shows the typed line, expanded.
  await expect(frontTerminal(page)).toContainText('echo hello-snippets', { timeout: 30_000 });

  // A snippet with a secret: the value is stored from the editor, the script names it only.
  await showSnippets(page);
  await page.getByTestId('ssh-view-header').getByRole('button', { name: 'New snippet', exact: true }).click();
  await editor.getByLabel('Name', { exact: true }).fill('Token');
  await editor.getByLabel('Insert secret', { exact: true }).selectOption({ label: 'New secret…' });
  await editor.getByLabel('Secret name', { exact: true }).fill('snip_tok');
  await editor.getByLabel('Secret value', { exact: true }).fill(SECRET);
  await editor.getByRole('button', { name: 'Store and insert' }).click();
  await expect(editor.getByLabel('Secret value', { exact: true })).toBeHidden();
  await setMonacoText(page, 'Script', 'echo token=${secret:snip_tok}');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(snippetRow(page, 'Token')).toBeVisible();

  // ⌘; inside the terminal: the picker runs it into that terminal, where the echoed value shows as ••••.
  let terminal = await showTerminalOf(page, 'alpha');
  await terminal.click();
  await page.keyboard.press(`${MOD}+;`);
  await expect(page.getByTestId('snippet-picker')).toBeVisible();
  await page.getByTestId('snippet-picker-input').fill('Token');
  await expect(page.getByTestId('snippet-picker-item')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('snippet-picker')).toBeHidden();
  await expect(terminal).toContainText('echo token=••••', { timeout: 30_000 });
  await expect(page.locator('body')).not.toContainText(SECRET);
  expect(await page.content()).not.toContain(SECRET);

  // ⌘K → Run Snippet… lists both snippets. Pressed outside the terminal: Ctrl+K there belongs to the shell.
  await showSnippets(page);
  await page.keyboard.press(`${MOD}+k`);
  await expect(page.getByTestId('command-palette-input')).toBeVisible({ timeout: 20_000 });
  await page.keyboard.type('Run Snippet');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="palette-snippet"][data-name="Greet"]')).toBeVisible();
  await expect(page.locator('[data-testid="palette-snippet"][data-name="Token"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette-input')).toBeHidden();

  // Typing the start of Greet's first line shows the rest as a ghost; Tab asks for the value and completes
  // the line without pressing Enter.
  terminal = await showTerminalOf(page, 'alpha');
  await terminal.click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo hel');
  const ghost = page.getByTestId('snippet-ghost');
  await expect(ghost).toBeVisible({ timeout: 10_000 });
  await expect(ghost).toContainText('lo-${who}');
  await expect(ghost).toContainText('Greet · Tab');
  await page.keyboard.press('Tab');
  dialog = page.getByTestId('snippet-run-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('who', { exact: true }).fill('tab');
  await dialog.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(ghost).toHaveCount(0);
  await expect(terminal).toContainText('echo hello-tab', { timeout: 30_000 });

  // Run on two hosts: the open terminal on alpha, and beta through a chip, which opens its terminal.
  await showSnippets(page);
  await snippetRow(page, 'Greet').getByRole('button', { name: 'Snippet actions' }).click();
  await page.getByRole('menuitem', { name: 'Run…' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'alpha' }).check();
  await dialog.getByRole('button', { name: 'Add host, group or tag' }).click();
  await dialog.getByTestId('snippet-run-target-input').fill('beta');
  await dialog.getByRole('option', { name: 'Host beta' }).click();
  await expect(dialog.getByTestId('snippet-run-chip')).toContainText('beta');
  await dialog.getByLabel('who', { exact: true }).fill('both');
  await dialog.getByRole('button', { name: 'Run on 2 hosts' }).click();
  await expect(dialog).toBeHidden();
  // A new terminal is typed into once its shell has been quiet; the fixture's prints nothing, so up to 10 s.
  await expect(page.getByTestId('toast-viewport')).toContainText('Ran on 2 hosts', { timeout: 60_000 });

  terminal = await showTerminalOf(page, 'beta');
  await expect(terminal).toContainText('echo hello-both', { timeout: 30_000 });
  terminal = await showTerminalOf(page, 'alpha');
  await expect(terminal).toContainText('echo hello-both', { timeout: 30_000 });
});
