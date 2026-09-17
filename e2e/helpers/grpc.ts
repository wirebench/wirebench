/**
 * The gestures a gRPC spec needs, so each spec reads as what the user did: import a `.proto` set
 * into the selected project, open one of the requests the import made, put a message in it, send
 * it, and look at the response.
 */
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { setMonacoText } from './editor.js';
import { chooseContextMenuItem } from './rest.js';

/** The crafted greeter fixture the engine's own gRPC tests use, shared with the test server. */
export const GREETER_FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/proto/crafted/greeter/', import.meta.url));

/**
 * Copies the greeter `.proto` set into `protos/` under a project folder and returns the root file's
 * path. A renderer-named path is read only inside a project folder or after a Browse… pick, so the
 * files go where the rule allows — which is also where a team would keep them.
 */
export function placeGreeterProtos(projectDir: string): string {
  const dir = join(projectDir, 'protos');
  mkdirSync(dir, { recursive: true });
  cpSync(GREETER_FIXTURE_DIR, dir, { recursive: true });
  return join(dir, 'greeter.proto');
}

/**
 * Imports `protoPath` through the unified Import dialog on its `.proto` format, naming the API and
 * pointing it at `target`, and waits for the API's explorer row.
 */
export async function importProto(page: Page, protoPath: string, name: string, target: string): Promise<void> {
  const projectRow = page.getByTestId('explorer-project-row').first();
  await expect(projectRow).toBeVisible({ timeout: 20_000 });
  await chooseContextMenuItem(page, projectRow, 'Import…');
  await page.getByTestId('import-format-select').selectOption('proto');
  await expect(page.getByTestId('import-proto-dialog')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('tab', { name: 'File' }).click();
  await page.getByTestId('import-file-input').fill(protoPath);
  await page.getByTestId('import-name-input').fill(name);
  await page.getByTestId('import-base-url-input').fill(target);
  await page.getByTestId('import-submit').click();

  await expect(page.getByTestId('import-proto-summary')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-done').click();
  await expect(grpcApiRow(page, name)).toBeVisible({ timeout: 20_000 });
}

/** The explorer row for one gRPC API. */
export function grpcApiRow(page: Page, name: string): Locator {
  return page.getByTestId('grpc-api-row').filter({ hasText: name });
}

/** Unfolds the whole tree and opens the gRPC request row reading `name`. */
export async function openGrpcRequest(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Expand all' }).click();
  const row = page.getByTestId('grpc-request-row').filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByTestId('grpc-editor')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('grpc-breadcrumb-name')).toHaveText(name);
}

/** Replaces the open request's message text. */
export async function setMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('tablist', { name: 'Request tabs' }).getByRole('tab', { name: 'Message' }).click();
  await setMonacoText(page, 'Request message', text);
}

/** Sends the open gRPC request and waits for its status line. */
export async function sendGrpc(page: Page): Promise<void> {
  await page.getByTestId('grpc-send').click();
  await expect(page.getByTestId('grpc-response-status')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('grpc-response-status')).not.toHaveText('Sending…', { timeout: 20_000 });
}

/** The response status line. */
export function grpcStatus(page: Page): Locator {
  return page.getByTestId('grpc-response-status');
}

/** Opens one response tab by its label — Messages, Metadata, Timing, TLS, Raw. */
export async function openGrpcResponseTab(page: Page, tab: string): Promise<void> {
  await page.getByRole('tablist', { name: 'Response tabs' }).getByRole('tab', { name: tab }).click();
}
