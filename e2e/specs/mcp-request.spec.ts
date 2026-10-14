import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { chooseContextMenuItem } from '../helpers/rest.js';

/**
 * The stdio fixture server, from this file rather than the process's cwd: CI runs the specs with the
 * cwd at `<repo>/e2e`. It is plain JSON-RPC over stdin and stdout, so it needs nothing installed.
 */
const FIXTURE_SERVER = fileURLToPath(new URL('../fixtures/mcp-stdio/server.mjs', import.meta.url));

/**
 * The Node binary running this spec. The app spawns the command with no shell, so it gets an
 * absolute path rather than a `node` it would have to find on PATH.
 */
const NODE = process.execPath;

/** One request's editor, by its name: other requests' editors may stay mounted in hidden tabs. */
function mcpEditor(page: Page, name: string): Locator {
  return page.getByRole('region', { name: `Request ${name}` });
}

/** Sends the request open in `editor` and waits until the send has finished. */
async function sendMcp(editor: Locator): Promise<void> {
  await editor.getByTestId('mcp-send').click();
  const outcome = editor.getByTestId('mcp-response-outcome');
  await expect(outcome).toBeVisible({ timeout: 30_000 });
}

/**
 * An MCP server over stdio, end to end (#79, spec: Testing, E2E): New MCP server… with the fixture's
 * command line, the approval dialog on the first refresh (Always allow), the catalogue's tools, a
 * request made from a tool and sent, and a tool that answers `isError` reading as a tool error.
 */
test.describe('MCP: a stdio server is approved, catalogued and called', () => {
  let launched: LaunchedApp | undefined;
  let userDataDir: string | undefined;

  test.beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-mcp-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
  });

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test('refresh asks once, a tool call shows its text, and isError reads as a tool error', async () => {
    test.setTimeout(180_000);
    const page = launched!.window;
    await createWorkspace(page, 'MCP');
    await createProject(page, 'Agents');

    // --- New MCP server…: a local process, the fixture run by this Node ---------------------------
    const projectRow = page.getByTestId('explorer-project-row').first();
    await chooseContextMenuItem(page, projectRow, 'New MCP server…');
    const dialog = page.getByTestId('new-mcp-server-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('new-mcp-server-name').fill('Fixture');
    await page.getByTestId('new-mcp-server-transport-stdio').check();
    await page.getByTestId('new-mcp-server-command').fill(NODE);
    await page.getByTestId('new-mcp-server-args').fill(FIXTURE_SERVER);
    await page.getByTestId('new-mcp-server-create').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });

    const serverTab = page.getByTestId('mcp-api-tab');
    await expect(serverTab).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('mcp-api-row').filter({ hasText: 'Fixture' })).toBeVisible({ timeout: 20_000 });
    await expect(serverTab.getByTestId('mcp-api-fetched')).toHaveText('Not fetched yet.');

    // --- Refresh: the command line has not run on this machine, so it is asked about first -------
    await serverTab.getByTestId('mcp-api-refresh').click();
    const approval = page.getByTestId('mcp-approval-dialog');
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval.getByTestId('mcp-approval-server')).toHaveText('Fixture');
    await expect(approval.getByTestId('mcp-approval-command')).toContainText('server.mjs');
    await approval.getByTestId('mcp-approval-always').click();
    await expect(approval).toBeHidden({ timeout: 20_000 });

    await expect(serverTab.getByTestId('mcp-api-fetched')).toContainText('from e2e-fixture 1.0.0', {
      timeout: 30_000,
    });
    await expect(serverTab.getByTestId('mcp-api-refresh-error')).toHaveCount(0);
    const tools = serverTab.getByTestId('mcp-api-tools-row');
    await expect(tools).toHaveCount(2);
    await expect(tools.filter({ hasText: 'echo' })).toContainText('Echoes its text');

    // Always allow is kept per machine, in the profile, never in the project.
    expect(existsSync(join(userDataDir!, 'mcp-approvals.json'))).toBe(true);
    expect(readFileSync(join(userDataDir!, 'mcp-approvals.json'), 'utf8')).toContain('"fingerprint"');

    // --- a request from the echo tool: arguments in, its text back --------------------------------
    await serverTab.getByRole('button', { name: 'New request for echo' }).click();
    const echo = mcpEditor(page, 'echo');
    await expect(echo).toBeVisible({ timeout: 20_000 });
    await expect(echo.getByTestId('mcp-method')).toHaveValue('tools/call');
    await expect(echo.getByTestId('mcp-tool')).toHaveValue('echo');
    await setMonacoText(page, 'Tool arguments', '{ "text": "hello from e2e" }');
    await sendMcp(echo);
    // The command line is the one approved, so the send runs without asking again.
    await expect(approval).toBeHidden();
    await expect(echo.getByTestId('mcp-response-outcome')).toHaveText('OK', { timeout: 30_000 });
    await expect(echo.getByTestId('mcp-text-body')).toHaveText('echo: hello from e2e');

    // --- the fail tool answers isError: a tool error, not a failed session ------------------------
    await page.getByTestId('mcp-api-row').filter({ hasText: 'Fixture' }).click();
    await expect(serverTab).toBeVisible({ timeout: 20_000 });
    await serverTab.getByRole('button', { name: 'New request for fail' }).click();
    const fail = mcpEditor(page, 'fail');
    await expect(fail).toBeVisible({ timeout: 20_000 });
    await sendMcp(fail);
    await expect(approval).toBeHidden();
    await expect(fail.getByTestId('mcp-response-outcome')).toHaveText('Tool error (isError)', { timeout: 30_000 });
    await expect(fail.getByTestId('mcp-text-body')).toHaveText('the fixture tool failed on purpose');
  });
});
