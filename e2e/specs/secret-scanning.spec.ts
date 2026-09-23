import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace, workspaceProjectDir } from '../helpers/project.js';
import { addHeader, createApi, createRestRequest, setMethodAndUrl } from '../helpers/rest.js';

/** A JWT in shape only: `{"fake":1}` twice and the text `fake-signature`, base64url-encoded. */
const FAKE_JWT = 'eyJmYWtlIjoxfQ.eyJmYWtlIjoxfQ.ZmFrZS1zaWduYXR1cmU';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Every file under `dir`, recursively, concatenated: where the header lands is not this spec's business. */
function projectText(dir: string): string {
  const texts: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        texts.push(readFileSync(path, 'utf8'));
      }
    }
  };
  walk(dir);
  return texts.join('\n');
}

/**
 * A credential pasted into a header is caught by the manual save, moved into the secret store from
 * the review dialog, and the file on disk carries a `${secret:name}` token instead — read back from
 * the project folder, because a dialog closing is not evidence of what was written.
 */
test.describe('secret scanning on save', () => {
  let launched: LaunchedApp | undefined;

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
  });

  test('Mod+S lists a pasted bearer token, and Move to secret writes a token in its place', async () => {
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'Secrets');
    await createProject(page, 'Billing');
    // Never sent: the base URL only has to be there for the request to be made.
    await createApi(page, 'Billing API', 'http://127.0.0.1:9');
    await createRestRequest(page, 'Billing API', 'Invoices');
    await setMethodAndUrl(page, 'GET', '/invoices');
    await addHeader(page, 'Authorization', `Bearer ${FAKE_JWT}`);

    await page.keyboard.press(`${MOD}+s`);

    const dialog = page.getByTestId('secret-review-dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect(dialog).toContainText('Possible secret found');
    const row = dialog.getByTestId('secret-review-row').filter({ hasText: 'header Authorization' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('JSON web token');
    // A preview only — the first three characters and the length — never the value.
    await expect(row).toContainText(`eyJ… (${String(FAKE_JWT.length)} chars)`);
    await expect(dialog).not.toContainText(FAKE_JWT);
    await expect(row.getByRole('textbox')).toHaveValue('authorization');

    await row.getByRole('button', { name: 'Move to secret' }).click();

    // Nothing left to review: the dialog closes and the save it stood in front of goes ahead.
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(page.getByTestId('title-bar-dirty')).toHaveCount(0, { timeout: 20_000 });

    const dir = workspaceProjectDir(launched.userDataDir);
    await expect.poll(() => projectText(dir), { timeout: 20_000 }).toContain('${secret:authorization}');
    const saved = projectText(dir);
    expect(saved).toContain('Bearer ${secret:authorization}');
    expect(saved).not.toContain(FAKE_JWT);
  });
});
