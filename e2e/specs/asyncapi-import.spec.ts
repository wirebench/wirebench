/**
 * Importing an AsyncAPI document and checking live frames against it, end to end.
 *
 * The unit and IPC suites prove the mapping, the frame check and the markers one layer at a time.
 * What only the real app can prove is the whole chain: a 3.0 document fetched over HTTP becomes a
 * WebSocket API, its request connects to a real server, the saved sample goes out clean, and a
 * frame that breaks the contract is marked on the timeline with the failing path in its detail.
 *
 * Everything is local: the document and its sibling `schemas.yaml` are served by the in-process
 * REST test server, and the WebSocket server echoes each frame back.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { chooseContextMenuItem } from '../helpers/rest.js';
import {
  startTestRestServer,
  startTestWsServer,
  type TestRestServer,
  type TestWsServer,
} from '../helpers/test-server.js';

const fixturesDir = fileURLToPath(new URL('../../packages/engine/test/fixtures/asyncapi/', import.meta.url));

/**
 * The 3.0 chat fixture with its `public` server pointed at the running WebSocket test server. A
 * fixture cannot know the port it will meet, so the host and scheme are rewritten on the way out.
 */
function chatDocuments(wsPort: number): Record<string, { body: string; contentType: string }> {
  const chat = readFileSync(join(fixturesDir, 'chat-3.0.yaml'), 'utf-8')
    .replace("host: '{region}.chat.example.test'", `host: '127.0.0.1:${String(wsPort)}'`)
    .replace('protocol: wss', 'protocol: ws');
  return {
    '/asyncapi/chat-3.0.yaml': { body: chat, contentType: 'application/yaml' },
    '/asyncapi/schemas.yaml': {
      body: readFileSync(join(fixturesDir, 'schemas.yaml'), 'utf-8'),
      contentType: 'application/yaml',
    },
  };
}

test.describe('AsyncAPI import', () => {
  let launched: LaunchedApp | undefined;
  let docs: TestRestServer | undefined;
  let ws: TestWsServer | undefined;
  let userDataDir: string | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
      launched = undefined;
    }
    await docs?.close();
    await ws?.close();
    docs = undefined;
    ws = undefined;
    if (userDataDir !== undefined) {
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      userDataDir = undefined;
    }
  });

  test('imports a 3.0 document, sends its sample clean, and marks a frame that breaks the contract', async () => {
    ws = await startTestWsServer();
    docs = await startTestRestServer({ documents: chatDocuments(ws.port) });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-asyncapi-'));
    launched = await launchApp({ userDataDir, keepUserDataDir: true });
    const page = launched.window;
    await createWorkspace(page, 'AsyncAPI');
    await createProject(page, 'Chat');

    // Import… from the project row, by URL, as AsyncAPI.
    await chooseContextMenuItem(page, page.getByTestId('explorer-project-row').first(), 'Import…');
    await page.getByTestId('import-format-select').selectOption('asyncapi');
    await page.getByTestId('import-url-input').fill(`${docs.url}/asyncapi/chat-3.0.yaml`);
    await page.getByTestId('import-submit').click();

    // The summary counts what was mapped and lists what was not: the Kafka channel and MQTT server.
    await expect(page.getByTestId('import-asyncapi-summary')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('import-asyncapi-counts')).toContainText('1 request, 1 message');
    const skipped = page.getByTestId('import-asyncapi-skipped');
    await expect(skipped).toContainText('channel audit');
    await expect(skipped).toContainText('server telemetry');
    await page.getByTestId('import-done').click();

    // API → tag folder → channel request.
    const apiRow = page.getByTestId('ws-api-row').filter({ hasText: 'Chat service' });
    await expect(apiRow).toBeVisible({ timeout: 20_000 });
    const folder = page.getByTestId('folder-row').filter({ hasText: 'chat' });
    if (!(await folder.isVisible())) await apiRow.click();
    await expect(folder).toBeVisible({ timeout: 20_000 });
    const requestRow = page.getByTestId('ws-request-row').filter({ hasText: 'userChat' });
    if (!(await requestRow.isVisible())) await folder.click();
    await requestRow.click();
    await expect(page.getByTestId('ws-editor')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('ws-connect').click();
    await expect(page.getByTestId('ws-state')).toContainText('open', { timeout: 20_000 });

    // The saved sample goes out and matches its message: no marker on the sent row.
    const messageRow = page.getByTestId('ws-message-row').filter({ hasText: 'sendChat' });
    await expect(messageRow).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send sendChat' }).click();
    const frames = page.getByTestId('ws-frame-row');
    const sent = frames.filter({ has: page.getByRole('img', { name: 'Sent' }) });
    await expect(sent).toHaveCount(1, { timeout: 20_000 });
    await expect(sent.first()).toContainText('Hello');
    // The echo arrives too; wait for it so the check has had its turn on both frames.
    await expect(frames).toHaveCount(2, { timeout: 20_000 });
    await expect(sent.first().getByTestId('ws-frame-contract-marker')).toHaveCount(0);

    // A broken message: `text` must be a string.
    await page.getByTestId('ws-composer-text').fill('{"type":"message","text":42}');
    await page.getByTestId('ws-composer-send').click();
    await expect(sent).toHaveCount(2, { timeout: 20_000 });
    const brokenMarker = sent.nth(1).getByTestId('ws-frame-contract-marker');
    await expect(brokenMarker).toHaveAttribute('data-status', 'violation', { timeout: 20_000 });

    // Its detail names the message and the failing path.
    await sent.nth(1).click();
    const contract = page.getByTestId('ws-frame-contract');
    await expect(contract).toContainText('Does not match sendChat');
    await expect(contract).toContainText('/text');

    // "Contract problems only" hides the clean sample.
    await page.getByTestId('ws-timeline-contract-only').check();
    await expect(sent).toHaveCount(1);
    await expect(sent.first()).toContainText('42');
  });
});
