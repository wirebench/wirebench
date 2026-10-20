/**
 * A request that still holds the generator's template "?" values asks before it is sent (#728):
 * once, with Send anyway, after which that request sends without asking again.
 */
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

test.describe('template values on send', () => {
  let launched: LaunchedApp | undefined;
  let server: TestSoapServer | undefined;

  test.afterEach(async () => {
    await launched?.close();
    await server?.close();
    launched = undefined;
    server = undefined;
  });

  test('asks before sending "?", sends on Send anyway, and does not ask again for that request', async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    launched = await launchApp({ templateSendAsk: true });
    const page = launched.window;
    await createProjectWithCalculator(page, server);
    await openFirstRequest(page);

    const posts = (): number => server!.requests.filter((request) => request.method === 'POST').length;
    const before = posts();
    await page.getByTestId('request-send').click();
    const toast = page.getByTestId('toast-viewport');
    await expect(toast).toContainText('values still hold the template "?"', { timeout: 10_000 });
    expect(posts()).toBe(before);

    await toast.getByRole('button', { name: 'Send anyway' }).click();
    await expect(page.getByTestId('response-status')).toContainText('200', { timeout: 20_000 });
    expect(posts()).toBe(before + 1);

    await page.getByTestId('request-send').click();
    await expect.poll(posts, { timeout: 20_000 }).toBe(before + 2);
  });
});
