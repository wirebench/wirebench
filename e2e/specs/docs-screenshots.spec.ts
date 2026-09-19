import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  captureWindow,
  resizeWindow,
  restTimingRegions,
  setTheme,
  SHOWN_REMOTE,
  shownRemoteEnv,
  timingRegions,
} from '../helpers/capture.js';
import { setMonacoText } from '../helpers/editor.js';
import { environmentRow, openEnvironmentsView } from '../helpers/environments.js';
import { createBareRemote } from '../helpers/git-remote.js';
import { grpcStatus, importProto, openGrpcRequest, placeGreeterProtos, sendGrpc, setMessage } from '../helpers/grpc.js';
import { logRows, selectLogRow } from '../helpers/http-log.js';
import { launchApp, removeDirSync, type LaunchedApp } from '../helpers/launch-app.js';
import { runCommand } from '../helpers/palette.js';
import {
  createProject,
  createProjectWithCalculator,
  createWorkspace,
  expandExplorer,
  openFirstRequest,
  workspaceProjectDir,
  openImportDialog,
  saveAll,
} from '../helpers/project.js';
import {
  addHeader,
  apiRow,
  chooseContextMenuItem,
  createApi,
  createRestRequest,
  openRequestTab,
  responseStatus,
  sendRest,
  setMethodAndUrl,
} from '../helpers/rest.js';
import { openManageWorkspaces } from '../helpers/sync.js';
import { joinSharedWorkspace, openConflictResolver, produceRequestConflict, shareWorkspace } from '../helpers/sync.js';
import {
  startTestGrpcServer,
  startTestRestServer,
  startTestSoapServer,
  type TestGrpcServer,
  type TestRestServer,
  type TestSoapServer,
} from '../helpers/test-server.js';

/** The legacy single-XML SOAP project the import spec reads. */
const LEGACY_FIXTURE = fileURLToPath(new URL('../../fixtures/legacy-soap-project/full.xml', import.meta.url));

/** The platform's `Mod`: ⌘ on macOS, Ctrl elsewhere. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Captures the docs site's screenshots into `docs-site/public/images/<page>/<name>.png`.
 *
 * The same idea as `screenshots.spec.ts`, which shoots the README: every picture on the site is
 * produced by the real app against the in-process test servers, so it can only show a screen the
 * app can reach, and re-shooting after a UI change is one command. It is skipped unless
 * `WIREBENCH_DOCS_SCREENSHOTS=1`; `pnpm docs:screenshots` builds the app and sets it:
 *
 * ```
 * pnpm docs:screenshots
 * ```
 *
 * Light theme, unlike the README's dark one: the site's default reading theme is light. The
 * images are committed; `pnpm check:docs-images` fails when a page cites one that is not there,
 * or one is there that no page cites.
 */

/** Repo root, from `e2e/specs/` up two levels. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Where the site serves its images from, one folder per page. */
const IMAGES_DIR = join(REPO_ROOT, 'docs-site', 'public', 'images');

/** The same tripwire as the README's: a page of 300 KB images is slow on a phone. */
const MAX_BYTES = 300 * 1024;

/**
 * Shoots the whole window into `docs-site/public/images/<shot>.png`, `shot` being `<page>/<name>`.
 * The status bar's last-request and last-saved clock times are masked on every shot, since any
 * screen can show them; `mask` adds the regions a particular screen needs on top.
 */
async function shoot(page: Page, shot: string, options: { mask?: Locator[] } = {}): Promise<void> {
  const mask = [...(options.mask ?? []), page.getByTestId('status-bar-last'), page.getByTestId('status-bar-save')];
  await captureWindow(page, join(IMAGES_DIR, `${shot}.png`), { mask, maxBytes: MAX_BYTES });
}

/**
 * A collection that loses a little of everything a switcher might have: scripts, a folder variable,
 * a dynamic variable, a password and an auth type there is no field for. The summary it produces is
 * the one the Postman switching page explains.
 */
const SWITCHING_COLLECTION = JSON.stringify({
  info: { name: 'Petstore', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [
    { key: 'baseUrl', value: 'https://petstore.example.com/v2' },
    { key: 'tenant', value: 'acme' },
  ],
  auth: {
    type: 'basic',
    basic: [
      { key: 'username', value: '{{user}}' },
      { key: 'password', value: 'not-copied' },
    ],
  },
  event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("ts", Date.now());'] } }],
  item: [
    {
      name: 'Pets',
      item: [
        {
          name: 'List pets',
          event: [{ listen: 'test', script: { exec: ['pm.test("200", () => pm.response.to.have.status(200));'] } }],
          request: { method: 'GET', url: '{{baseUrl}}/pets?tenant={{tenant}}' },
        },
        {
          name: 'Create pet',
          request: {
            method: 'POST',
            url: '{{baseUrl}}/pets',
            header: [{ key: 'X-Request-Id', value: '{{$guid}}' }],
            body: { mode: 'raw', raw: '{"name":"Fido"}', options: { raw: { language: 'json' } } },
          },
        },
      ],
    },
    {
      name: 'Signed upload',
      request: { method: 'PUT', url: '{{baseUrl}}/uploads', auth: { type: 'awsv4' } },
    },
  ],
});

/**
 * An OpenAPI document with the things an import reports: two security schemes to choose from (one
 * with a flow there is no field for), a cookie parameter, a second media type, a webhook and a
 * vendor extension. The summary it produces is the one the OpenAPI switching page explains.
 */
const SWITCHING_OPENAPI = [
  'openapi: 3.1.0',
  'info:',
  '  title: Petstore',
  '  version: 1.4.0',
  'servers:',
  '  - url: https://petstore.example.com/v2',
  'security:',
  '  - apiKey: []',
  '  - oauth: []',
  'tags:',
  '  - name: pets',
  'x-internal-owner: platform',
  'paths:',
  '  /pets:',
  '    get:',
  '      tags: [pets]',
  '      summary: List pets',
  '      parameters:',
  '        - { name: limit, in: query, schema: { type: integer }, example: 20 }',
  '        - { name: session, in: cookie, schema: { type: string } }',
  '      responses: { "200": { description: OK } }',
  '    post:',
  '      tags: [pets]',
  '      summary: Create a pet',
  '      requestBody:',
  '        content:',
  '          application/json: { schema: { type: object, properties: { name: { type: string } } } }',
  '          application/xml: { schema: { type: object } }',
  '      responses: { "201": { description: Created } }',
  'webhooks:',
  '  petAdopted:',
  '    post: { responses: { "200": { description: OK } } }',
  'components:',
  '  securitySchemes:',
  '    apiKey: { type: apiKey, in: header, name: X-Api-Key }',
  '    oauth:',
  '      type: oauth2',
  '      flows: { password: { tokenUrl: "https://id.example.com/token", scopes: {} } }',
].join('\n');

/** A Calculator `Add` envelope summing `intA` and `intB`. */
function addEnvelope(intA: string, intB: string): string {
  return [
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
    '   <soapenv:Header/>',
    '   <soapenv:Body>',
    '      <tem:Add>',
    `         <tem:intA>${intA}</tem:intA>`,
    `         <tem:intB>${intB}</tem:intB>`,
    '      </tem:Add>',
    '   </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

test.describe('docs site screenshots', () => {
  test.skip(
    process.env['WIREBENCH_DOCS_SCREENSHOTS'] !== '1',
    'set WIREBENCH_DOCS_SCREENSHOTS=1 (or run `pnpm docs:screenshots`) to re-shoot the docs site images',
  );

  let launched: LaunchedApp | undefined;
  /** The second profile of the conflict capture, which needs someone to conflict with. */
  let second: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;
  let remoteDir: string | undefined;
  let restServer: TestRestServer | undefined;
  let grpcServer: TestGrpcServer | undefined;

  test.afterEach(async () => {
    const failures: unknown[] = [];
    for (const app of [launched, second]) {
      if (app) {
        await app.close().catch((error: unknown) => failures.push(error));
      }
    }
    launched = undefined;
    second = undefined;
    if (server) {
      await server.close();
      server = undefined;
    }
    if (restServer) {
      await restServer.close();
      restServer = undefined;
    }
    if (grpcServer) {
      await grpcServer.close();
      grpcServer = undefined;
    }
    if (remoteDir !== undefined) {
      removeDirSync(remoteDir);
      remoteDir = undefined;
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  });

  test('getting started: workspace picker', async () => {
    launched = await launchApp();
    await resizeWindow(launched);
    await setTheme(launched.window, 'light');
    await expect(launched.window.getByTestId('workspace-picker')).toBeVisible();
    await shoot(launched.window, 'getting-started/workspace-picker');
  });

  test('getting started: import, request editor and response', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window);
    await createProject(window, 'Calculator Project');
    await openImportDialog(window, 'wsdl');
    await window.getByTestId('import-url-input').fill(server.wsdlUrl);
    await shoot(window, 'getting-started/import-wsdl');

    await window.getByTestId('import-submit').click();
    await expandExplorer(window, 'Request 1');
    await openFirstRequest(window);
    await shoot(window, 'getting-started/request-editor');

    await window.getByTestId('request-send').click();
    await expect(window.getByTestId('response-status')).toContainText(/\d{3}/, { timeout: 20_000 });
    await shoot(window, 'getting-started/response', { mask: timingRegions(window) });
  });

  test('REST client: a request and its response', async () => {
    restServer = await startTestRestServer();
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await createProject(window, 'Pet Service');
    await createApi(window, 'Petstore', restServer.url);
    await createRestRequest(window, 'Petstore', 'Echo a query');
    await setMethodAndUrl(window, 'GET', '/echo?pet=Fido&limit=10');
    await sendRest(window);
    await expect(window.getByTestId('rest-response-status')).toContainText(/\d{3}/, { timeout: 20_000 });
    await shoot(window, 'rest-client/rest-response', { mask: restTimingRegions(window) });
  });

  test('SOAP: an outgoing WS-Security configuration', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createProjectWithCalculator(window, server);
    await openFirstRequest(window);
    await window.getByRole('button', { name: 'WS-Security' }).click();
    await expect(window.getByTestId('wss-section')).toBeVisible();
    await window.getByTestId('wss-outgoing-add').click();
    const row = window.getByTestId('wss-outgoing-row');
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { expanded: false }).click();
    const editor = window.getByTestId('wss-outgoing-editor');
    await expect(editor).toBeVisible();
    await editor.getByLabel('Add entry').selectOption('timestamp');
    await editor.getByLabel('Add entry').selectOption('username-token');
    await expect(window.getByTestId('wss-entry-row')).toHaveCount(2);
    await editor.getByRole('textbox', { name: 'Username' }).fill('bob');
    await expect(editor.getByLabel('Password type')).toHaveValue('digest');
    await shoot(window, 'soap-wsdl/wss-outgoing');
  });

  test('REST client: a raw JSON body', async () => {
    restServer = await startTestRestServer();
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await createProject(window, 'Pet Service');
    await createApi(window, 'Petstore', restServer.url);
    await createRestRequest(window, 'Petstore', 'Create a pet');
    await setMethodAndUrl(window, 'POST', '/echo');
    await openRequestTab(window, 'Body');
    await window.getByTestId('rest-body-kind').selectOption('raw');
    await setMonacoText(window, 'Request body', '{\n  "name": "Fido",\n  "tag": "dog"\n}');
    await shoot(window, 'rest-client/body-tab');
  });

  test('gRPC: a unary call and its reply', async () => {
    grpcServer = await startTestGrpcServer();
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await createProject(window, 'Greet');
    const protoPath = placeGreeterProtos(workspaceProjectDir(launched.userDataDir, 'Greet'));
    await importProto(window, protoPath, 'Greeter', grpcServer.target);
    await openGrpcRequest(window, 'SayHello');
    await setMessage(window, '{"name":"Ada","tags":["x"]}');
    await sendGrpc(window);
    await expect(grpcStatus(window)).toContainText('OK (0)');
    await expect(window.getByTestId('grpc-response-messages')).toContainText('Hello, Ada');
    await shoot(window, 'grpc/unary-response', {
      mask: [grpcStatus(window), logRows(window), window.getByTestId('status-bar-last')],
    });
  });

  test('importers: a pasted cURL command and its preview', async () => {
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await createProject(window, 'Pet Service');
    await createApi(window, 'Petstore', 'https://api.example.com');
    await apiRow(window, 'Petstore').click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Import cURL…' }).click();
    await expect(window.getByTestId('import-curl-target')).toContainText('the API “Petstore”');
    await window.getByLabel('cURL command').click();
    await window.keyboard.insertText(
      `curl -X POST 'https://api.example.com/pets?dry=true' -H 'Content-Type: application/json' -H 'X-From: curl' -d '{"name":"Fido"}'`,
    );
    await expect(window.getByTestId('import-curl-submit')).toBeEnabled();
    await shoot(window, 'importers/curl-preview');
  });

  test('importers: the legacy SOAP project summary', async () => {
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window);
    await createProject(window, 'Billing');
    // A renderer-named path is read only inside a project folder, so the file goes there first.
    const legacyPath = join(workspaceProjectDir(launched.userDataDir), 'billing-project.xml');
    copyFileSync(LEGACY_FIXTURE, legacyPath);
    await chooseContextMenuItem(window, window.getByTestId('explorer-project-row').first(), 'Import…');
    await window.getByTestId('import-format-select').selectOption('legacy-soap-project');
    await window.getByRole('tab', { name: 'File' }).click();
    await window.getByTestId('import-file-input').fill(legacyPath);
    await window.getByTestId('import-submit').click();
    await expect(window.getByTestId('import-legacy-summary')).toBeVisible({ timeout: 30_000 });
    await expect(window.getByTestId('import-legacy-counts')).toContainText('2 interfaces, 6 requests');
    // The project tab behind the dialog shows the project's folder: the test profile's temporary
    // directory, different on every run and nobody's business to publish.
    await shoot(window, 'importers/legacy-summary', { mask: [window.getByLabel('Folder', { exact: true })] });
  });

  test('environments: an endpoint override', async () => {
    server = await startTestSoapServer({ fixture: 'calculator' });
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createProjectWithCalculator(window, server);
    await openEnvironmentsView(window);
    await window.getByRole('button', { name: 'Add environment' }).click();
    const created = environmentRow(window, 'Environment 1');
    await expect(created).toBeVisible();
    await created.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Rename' }).click();
    await window.getByLabel('Rename Environment 1').fill('uat');
    await window.getByLabel('Rename Environment 1').press('Enter');
    await expect(environmentRow(window, 'uat')).toBeVisible();
    // "Add environment" already opened this environment's page.
    const override = window.getByLabel('Endpoint override for Calculator');
    await expect(override).toBeVisible({ timeout: 20_000 });
    await override.fill('https://uat.example.com/calculator/soap');
    await override.press('Enter');
    await shoot(window, 'environments/endpoint-override');
  });

  test('HTTP Log: a failed send beside a finished one', async () => {
    restServer = await startTestRestServer();
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await createProject(window, 'Pet Service');
    await createApi(window, 'Petstore', restServer.url);
    await createRestRequest(window, 'Petstore', 'Echo');
    await setMethodAndUrl(window, 'GET', '/echo');
    await sendRest(window);
    await expect(responseStatus(window)).toContainText('200');
    // Port 1 is reserved and nothing listens on it: the connection is refused at once.
    await createApi(window, 'Dead', 'http://127.0.0.1:1');
    await createRestRequest(window, 'Dead', 'Nope');
    await setMethodAndUrl(window, 'GET', '/nope');
    await addHeader(window, 'Authorization', 'Bearer e2e-placeholder');
    await sendRest(window);
    await expect(responseStatus(window)).toContainText('connection-refused');

    const rows = logRows(window);
    await expect(rows).toHaveCount(2);
    const failed = rows.last();
    await expect(failed).toHaveAttribute('data-kind', 'failure');
    await selectLogRow(failed);
    await window.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Response' }).click();
    await expect(window.getByTestId('log-detail-error')).toContainText('Connection refused');
    // With a row selected the log narrows to its compact columns, which carry no time or duration,
    // so the rows stay visible; only the response status line and the status bar carry timings.
    await shoot(window, 'http-log/failed-send', {
      mask: [responseStatus(window), window.getByTestId('status-bar-last')],
    });
  });

  test('history: two runs compared', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createProjectWithCalculator(window, server);
    await openFirstRequest(window);
    // Two different sums, so the diff has something to show: 5 against 42.
    for (const [intA, intB] of [
      ['2', '3'],
      ['20', '22'],
    ] as const) {
      await setMonacoText(window, 'Request envelope XML', addEnvelope(intA, intB));
      await window.getByTestId('request-send').click();
      await expect(window.getByTestId('response-status')).toContainText(/200/, { timeout: 10_000 });
    }
    await window.getByTestId('activity-bar').getByRole('button', { name: 'History' }).click();
    const rows = window.locator('[data-testid="history-row"]');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    const compareButtons = window.locator('button[title="Compare…"]');
    await compareButtons.nth(0).click();
    await compareButtons.nth(1).click();
    await expect(window.locator('[role="tab"]', { hasText: 'Compare' })).toBeVisible({ timeout: 10_000 });
    // The picture is the diff. The sidebar goes, since at this window size it clips the history
    // rows, and a clipped row's timing cells would still be masked over the diff. The diff's two
    // labels carry a clock time, so they are masked.
    await runCommand(window, 'Toggle Sidebar');
    await shoot(window, 'history/diff-view', {
      mask: [...timingRegions(window), window.locator('span[title^="Request 1 ("]')],
    });
  });

  test('workspaces: the manage dialog', async () => {
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await createProject(window, 'Pet Service');
    await window.getByTestId('workspace-switcher').click();
    await window.getByRole('menuitem', { name: 'Create workspace…' }).click();
    await createWorkspace(window, 'Staging');
    const dialog = await openManageWorkspaces(window);
    await expect(dialog.getByTestId('workspace-rename-name')).toHaveCount(2);
    // Each row's folder is the test profile's temporary directory, not a path a reader would have.
    await shoot(window, 'workspaces/manage-dialog', { mask: [dialog.locator('span.font-mono[title]')] });
  });

  test('preferences: the Shortcuts section', async () => {
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createWorkspace(window, 'Demo');
    await window.keyboard.press(`${MOD}+Comma`);
    await expect(window.getByTestId('preferences-editor')).toBeVisible({ timeout: 20_000 });
    await window.getByTestId('preferences-editor').getByRole('button', { name: 'Shortcuts', exact: true }).click();
    await expect(window.getByTestId('shortcuts-table')).toBeVisible();
    await shoot(window, 'preferences/shortcuts');
  });

  test('shared workspaces: sync panel', async () => {
    test.skip(process.platform !== 'darwin', 'the docs screenshots are shot on macOS');
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    remoteDir = remote.dir;
    launched = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');

    await createProjectWithCalculator(window, server);
    await saveAll(window);
    await shareWorkspace(window, SHOWN_REMOTE);
    await runCommand(window, 'Sync: Show Sync Panel');
    await expect(window.getByTestId('sync-panel')).toBeVisible();
    await expect(window.getByTestId('sync-log-row').first()).toBeVisible({ timeout: 20_000 });
    await shoot(window, 'shared-workspaces/sync-panel');
  });

  test('shared workspaces: conflict resolver', async () => {
    test.skip(process.platform !== 'darwin', 'the docs screenshots are shot on macOS');
    test.setTimeout(180_000);
    server = await startTestSoapServer({ fixture: 'calculator' });
    const remote = await createBareRemote();
    remoteDir = remote.dir;

    second = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    await createProjectWithCalculator(second.window, server);
    await saveAll(second.window);
    await shareWorkspace(second.window, SHOWN_REMOTE);

    launched = await launchApp({ extraEnv: shownRemoteEnv(remote.url) });
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');
    await joinSharedWorkspace(window, SHOWN_REMOTE);
    await produceRequestConflict(second.window, window, remote.dir);

    await openConflictResolver(window);
    await shoot(window, 'shared-workspaces/conflict-resolver');
  });

  test('switching: a Postman import summary', async () => {
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');
    await createWorkspace(window, 'Team APIs');
    await createProject(window, 'Pet Service');

    await openImportDialog(window, 'postman');
    await window.getByRole('tab', { name: 'Paste' }).click();
    await window.getByTestId('import-postman-paste').fill(SWITCHING_COLLECTION);
    await window.getByTestId('import-postman-submit').click();
    await expect(window.getByTestId('import-postman-warnings')).toBeVisible();
    await shoot(window, 'switching/postman-summary');
  });

  test('switching: an OpenAPI import summary', async () => {
    launched = await launchApp();
    const { window } = launched;
    await resizeWindow(launched);
    await setTheme(window, 'light');
    await createWorkspace(window, 'Team APIs');
    await createProject(window, 'Pet Service');

    await openImportDialog(window, 'openapi');
    await window.getByRole('tab', { name: 'Paste' }).click();
    await window.getByTestId('import-openapi-paste').fill(SWITCHING_OPENAPI);
    await window.getByTestId('import-openapi-submit').click();
    await expect(window.getByTestId('import-openapi-skipped')).toBeVisible();
    await shoot(window, 'switching/openapi-summary');
  });
});
