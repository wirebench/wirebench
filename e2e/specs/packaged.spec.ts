import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FuseState, getCurrentFuseWire } from '@electron/fuses';
import {
  launchPackagedApp,
  packagedExecutable,
  PACKAGED_APP,
  type LaunchedPackagedApp,
} from '../helpers/launch-app.js';
import { setMonacoText } from '../helpers/editor.js';
import { createProjectWithCalculator, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';
import { WIREBENCH_FUSES } from '../../scripts/fuses.ts';

/**
 * The slice of `window.wirebench` this spec calls. Declared locally rather than imported:
 * `e2e/tsconfig.json` has no DOM lib, so a `page.evaluate` callback cannot reference `window`
 * without a cast through a shape of its own (the same pattern `editor.spec.ts` uses).
 */
interface XpathApi {
  readonly xpath: {
    evaluate(request: { readonly xml: string; readonly expression: string; readonly language: 'xpath' }): Promise<
      | {
          readonly ok: true;
          readonly value: { readonly kind: string; readonly items?: readonly { readonly text: string }[] };
        }
      | { readonly ok: false }
    >;
  };
}

/**
 * The shipped artifact, exercised as an artifact.
 *
 * Everything else in this suite runs `out/main/index.js` with Electron's own binary, which
 * proves nothing about packaging: an asar changes how files resolve, `xmllint-wasm` reads its
 * `.wasm` off the disk, and the XPath worker is a separate file spawned by path. Those are
 * precisely the things that survive `pnpm build` and break in a `.dmg`, so this spec runs the
 * packaged build and makes both do real work — plus reads the Electron fuses back out of the
 * binary, because a fuse that silently failed to flip is invisible until it matters.
 *
 * Gated on `WIREBENCH_PACKAGED_APP` (the path to the built bundle), since the normal e2e run
 * has nothing packaged to point at:
 *
 * ```bash
 * pnpm package:mac
 * WIREBENCH_PACKAGED_APP="$PWD/apps/desktop/release/mac-universal/Wirebench.app" \
 *   pnpm --filter @wirebench/e2e test packaged
 * ```
 */
test.describe('packaged app', () => {
  test.skip(PACKAGED_APP === undefined, 'set WIREBENCH_PACKAGED_APP to the packaged bundle to run this spec');
  // A packaged launch pays for a real app start, and the WSDL import behind it.
  test.setTimeout(180_000);

  let launched: LaunchedPackagedApp | undefined;
  let server: TestSoapServer | undefined;
  let userDataDir = '';
  let projectDir = '';

  test.beforeEach(async () => {
    server = await startTestSoapServer({ fixture: 'calculator', respondToCalculatorAdd: true });
    userDataDir = mkdtempSync(join(tmpdir(), 'wirebench-e2e-profile-'));
    projectDir = join(mkdtempSync(join(tmpdir(), 'wirebench-e2e-projects-')), 'Packaged');
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

  test('ships the fuse wire it was built with', async () => {
    const wire = await getCurrentFuseWire(packagedExecutable(PACKAGED_APP!));

    for (const [fuse, expected] of Object.entries(WIREBENCH_FUSES)) {
      // The wire stores each fuse as a `FuseState` character code, not a boolean.
      expect(wire[Number(fuse) as keyof typeof wire], `fuse ${fuse}`).toBe(
        expected ? FuseState.ENABLE : FuseState.DISABLE,
      );
    }
  });

  test('launches to the Welcome screen', async () => {
    launched = await launchPackagedApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });

    await expect(launched.window.getByTestId('welcome-new-project')).toBeVisible({ timeout: 60_000 });
    await expect(launched.window.getByTestId('status-bar')).toBeVisible();
  });

  test('runs XPath (worker) and schema validation (xmllint-wasm) from inside the asar', async () => {
    launched = await launchPackagedApp({ userDataDir, folderDialogPath: projectDir, keepUserDataDir: true });
    const page = launched.window;

    // XPath runs on a `worker_threads` worker spawned from a file the asar has to be able to
    // hand out; a packaging mistake shows up here as an error result, not a wrong number.
    const xpath = await page.evaluate(async () => {
      const wirebench = (globalThis as unknown as { wirebench: XpathApi }).wirebench;
      return await wirebench.xpath.evaluate({
        xml: '<a><b>first</b><b>second</b></a>',
        expression: '/a/b/text()',
        language: 'xpath',
      });
    });
    expect(xpath.ok).toBe(true);
    expect(xpath.ok && xpath.value.kind).toBe('nodes');
    expect(xpath.ok ? (xpath.value.items ?? []).map((item) => item.text) : []).toEqual(['first', 'second']);

    // Validation compiles the interface's schema set through libxml2 — `xmllint-wasm`, whose
    // `.wasm` and worker are the files `asarUnpack` exists for.
    await createProjectWithCalculator(page, server!);
    await openFirstRequest(page);
    await setMonacoText(
      page,
      'Request envelope XML',
      [
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
        '   <soapenv:Header/>',
        '   <soapenv:Body>',
        '      <tem:Add>',
        '         <tem:intA>abc</tem:intA>',
        '         <tem:intB>2</tem:intB>',
        '      </tem:Add>',
        '   </soapenv:Body>',
        '</soapenv:Envelope>',
      ].join('\n'),
    );
    await page.getByTestId('request-validate').click();

    await page.getByTestId('status-bar-problems').click();
    const problem = page.getByTestId('problem-row').first();
    await expect(problem).toBeVisible({ timeout: 60_000 });
    await expect(problem).toContainText('intA');
  });
});
