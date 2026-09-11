import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { monacoEditor, setMonacoText } from '../helpers/editor.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

/** The Calculator `Add` request, with `intA` set to `value`. `intA` always lands on line 5. */
function addEnvelope(value: string): string {
  return [
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
    '   <soapenv:Header/>',
    '   <soapenv:Body>',
    '      <tem:Add>',
    `         <tem:intA>${value}</tem:intA>`,
    '         <tem:intB>2</tem:intB>',
    '      </tem:Add>',
    '   </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

/**
 * The slice of the Monaco namespace this spec reads through `globalThis.__wirebenchMonaco`.
 * Hand-written rather than imported: `monaco-editor` is a renderer dependency, not one of the
 * e2e package's, so its types are not resolvable from this tsconfig.
 */
interface MonacoHandle {
  readonly editor: {
    getModelMarkers(filter: { owner?: string }): { message: string; startLineNumber: number }[];
    getEditors(): { getSelection(): { startLineNumber: number } | null }[];
  };
}

/** The markers Monaco holds for the request editor's model, under the validation owner. */
async function validationMarkers(page: Page): Promise<{ message: string; startLineNumber: number }[]> {
  return page.evaluate(() => {
    const monaco = (globalThis as unknown as { __wirebenchMonaco?: MonacoHandle }).__wirebenchMonaco;
    if (monaco === undefined) {
      return [];
    }
    return monaco.editor
      .getModelMarkers({ owner: 'wirebench-validation' })
      .map((marker) => ({ message: marker.message, startLineNumber: marker.startLineNumber }));
  });
}

test.describe('message validation', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir = '';
  let projectDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Validation');
  });

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    if (server) {
      await server.close();
      server = undefined;
    }
    for (const dir of [userDataDir, projectDir]) {
      if (dir.length > 0) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    userDataDir = '';
    projectDir = '';
  });

  test('validating a bad intA reports it, reveals it, and clears once fixed', async () => {
    launched = await launchApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);

    await setMonacoText(page, 'Request envelope XML', addEnvelope('abc'));
    await page.getByTestId('request-validate').click();

    // The Problems panel names the offending element and the line it sits on.
    await page.getByTestId('status-bar-problems').click();
    const row = page.getByTestId('problem-row').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('intA');
    await expect(page.getByTestId('problem-location').first()).toHaveText('5');

    // ... and so does the editor, through a marker of its own on the same line.
    await expect
      .poll(async () => (await validationMarkers(page)).map((marker) => marker.startLineNumber), { timeout: 20_000 })
      .toContain(5);

    // Clicking the row takes the user to the line the problem is about.
    await row.click();
    await expect(monacoEditor(page, 'Request envelope XML')).toBeVisible();
    await expect
      .poll(
        async () =>
          await page.evaluate((): number => {
            const monaco = (globalThis as unknown as { __wirebenchMonaco?: MonacoHandle }).__wirebenchMonaco;
            return monaco?.editor.getEditors()[0]?.getSelection()?.startLineNumber ?? 0;
          }),
        { timeout: 15_000 },
      )
      .toBe(5);

    // Fixing the value and validating again leaves nothing behind.
    await setMonacoText(page, 'Request envelope XML', addEnvelope('1'));
    await page.getByTestId('request-validate').click();

    await expect(page.getByTestId('status-bar-problems')).toHaveText('0 problems', { timeout: 20_000 });
    await expect.poll(async () => (await validationMarkers(page)).length, { timeout: 20_000 }).toBe(0);
  });
});
