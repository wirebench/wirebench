import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import {
  environmentRow,
  openEnvironment,
  openEnvironmentsView,
  setVariable,
  toggleVariable,
} from '../helpers/environments.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** The calculator `Add` envelope, with `intA`/`intB` as given (a literal, or a `${…}` reference). */
function calculatorEnvelope(intA: string, intB: string): string {
  return (
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">\n' +
    '   <soapenv:Header/>\n' +
    '   <soapenv:Body>\n' +
    '      <tem:Add>\n' +
    `         <tem:intA>${intA}</tem:intA>\n` +
    `         <tem:intB>${intB}</tem:intB>\n` +
    '      </tem:Add>\n' +
    '   </soapenv:Body>\n' +
    '</soapenv:Envelope>'
  );
}

/** The `intA` value the last POST body sent to `server` carried. */
function lastIntA(server: TestSoapServer): string | undefined {
  const last = [...server.requests].reverse().find((request) => request.method === 'POST');
  return last?.body.toString('utf-8').match(/<tem:intA>([^<]*)<\/tem:intA>/)?.[1];
}

test.describe('environments', () => {
  let launched: LaunchedApp | undefined;
  let imported: TestSoapServer | undefined;
  let deployed: TestSoapServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    for (const server of [imported, deployed]) {
      if (server) {
        await server.close();
      }
    }
    imported = undefined;
    deployed = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true });
    }
    userDataDir = undefined;
  });

  test('an environment override redirects the send, and an unresolved property is a problem', async () => {
    // Two deployments of the same service: the WSDL is imported from the first, but the
    // environment points every request at the second.
    imported = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    deployed = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, imported);

    // --- add `uat` via the sidebar Environments view -------------------------
    await openEnvironmentsView(page);
    await page.getByRole('button', { name: 'Add environment' }).click();
    const created = environmentRow(page, 'Environment 1');
    await expect(created).toBeVisible();
    await created.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('Rename Environment 1').fill('uat');
    await page.getByLabel('Rename Environment 1').press('Enter');
    await expect(environmentRow(page, 'uat')).toBeVisible();

    // --- point it at the second server --------------------------------------
    // "Add environment" already opened this environment's page.
    const override = page.getByLabel('Endpoint override for Calculator');
    await expect(override).toBeVisible({ timeout: 20_000 });
    await override.fill(`${deployed.url}/soap`);
    await override.press('Enter');

    // --- activate it from the status bar ------------------------------------
    await page.getByTestId('env-switcher').click();
    await page.getByRole('menuitem', { name: 'uat', exact: true }).click();
    await expect(page.getByTestId('env-switcher')).toContainText('uat');

    // --- send: the override wins over the imported address ------------------
    // Back to the Explorer view — sending a request needs the interfaces tree, and adding the
    // environment above left the Environments view showing.
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await openFirstRequest(page);
    await expect(page.getByTestId('endpoint-env-badge')).toBeVisible();
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('status-bar')).toContainText('200', { timeout: 20_000 });

    expect(deployed.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    // The first server only ever served the definition; nothing was sent to it.
    expect(imported.requests.filter((request) => request.method === 'POST')).toHaveLength(0);

    // --- an unresolvable property reference is reported in Problems ---------
    // Replace the whole envelope with one where `intA` references a nonexistent environment
    // property, keeping the rest of the default Calculator `Add` skeleton intact.
    await setMonacoText(page, 'Request envelope XML', calculatorEnvelope('${#Env#missing}', '?'));
    await expect(page.getByTestId('request-editor')).toContainText('#Env#missing');
    // The debounced editor write has to reach disk before the pre-send dry run reads it back.
    await page.waitForTimeout(1_000);

    await page.getByTestId('request-send').click();
    await page.getByRole('tab', { name: /Problems/ }).click();
    await expect(page.getByTestId('problem-row').first()).toContainText('${#Env#missing}', { timeout: 20_000 });
  });

  test('unticking a variable in the active environment falls through to the workspace value, and back when reticked', async () => {
    imported = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));

    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, imported);

    // --- a workspace-level value, and an environment value that shadows it --
    await openEnvironmentsView(page);
    await environmentRow(page, 'Workspace').dblclick();
    await setVariable(page, 'intA', '100');

    await openEnvironmentsView(page);
    await page.getByRole('button', { name: 'Add environment' }).click();
    const created = environmentRow(page, 'Environment 1');
    await expect(created).toBeVisible();
    // "Add environment" already opened this environment's page.
    await setVariable(page, 'intA', '200');

    await page.getByTestId('env-switcher').click();
    await page.getByRole('menuitem', { name: 'Environment 1', exact: true }).click();
    await expect(page.getByTestId('env-switcher')).toContainText('Environment 1');

    // --- with the environment active and intA enabled, the environment's own value wins ------
    await page.getByRole('button', { name: 'Explorer', exact: true }).click();
    await openFirstRequest(page);
    await setMonacoText(page, 'Request envelope XML', calculatorEnvelope('${intA}', '3'));
    await page.waitForTimeout(1_000);
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('status-bar')).toContainText('200', { timeout: 20_000 });
    expect(lastIntA(imported)).toBe('200');

    // --- untick intA in the environment: the next send falls through to the workspace value --
    await openEnvironmentsView(page);
    await openEnvironment(page, 'Environment 1');
    await toggleVariable(page, 'intA');

    // Opening the environment page switched the editor area to its tab; the request tab is
    // still open (just not selected), so reselect it before sending again.
    await page.getByRole('tab', { name: 'Request 1' }).click();
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('status-bar')).toContainText('200', { timeout: 20_000 });
    expect(lastIntA(imported)).toBe('100');

    // --- tick it back: the environment's own value wins again -----------------------------
    await openEnvironmentsView(page);
    await openEnvironment(page, 'Environment 1');
    await toggleVariable(page, 'intA');

    await page.getByRole('tab', { name: 'Request 1' }).click();
    await page.getByTestId('request-send').click();
    await expect(page.getByTestId('status-bar')).toContainText('200', { timeout: 20_000 });
    expect(lastIntA(imported)).toBe('200');
  });
});
