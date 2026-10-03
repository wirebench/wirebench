import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { createApi, createRestRequest, responseStatus, sendRest, setMethodAndUrl } from '../helpers/rest.js';

/** A page that tries everything the preview must refuse; every resource points back at `origin`. */
function hostilePage(origin: string): string {
  return `<!doctype html><html><head>
<meta http-equiv="refresh" content="0; url=${origin}/refresh">
<link rel="stylesheet" href="${origin}/sheet.css">
<style>@import url("${origin}/import.css"); body { background: url("${origin}/bg.png"); }
@font-face { font-family: x; src: url("${origin}/font.woff"); } h1 { font-family: x; }</style>
<title>Original title</title>
</head><body onload="document.title='onload-ran'">
<h1 data-marker="static">Preview content</h1>
<img src="${origin}/pixel.png" alt="">
<object data="${origin}/object.bin"></object>
<form id="f" action="${origin}/post" method="post"><input name="a" value="1"><button id="go" type="submit">go</button></form>
<script>document.title='script-ran'; document.getElementById('f').submit();</script>
<a id="away" href="${origin}/away" target="_top">away</a>
</body></html>`;
}

test.describe('HTML preview (#48)', () => {
  let launched: LaunchedApp | undefined;
  let server: Server | undefined;
  const seen: string[] = [];

  test.afterEach(async () => {
    try {
      await launched?.close();
    } finally {
      launched = undefined;
      const open = server;
      server = undefined;
      seen.length = 0;
      await new Promise<void>((resolve) => (open ? open.close(() => resolve()) : resolve()));
    }
  });

  test('renders statically: no script, no request, no navigation', async () => {
    let origin = '';
    server = createServer((request, response) => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      if (request.url !== '/page') {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(hostilePage(origin));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    launched = await launchApp({
      // The browser logs its own refusals (sandbox, CSP) as console errors; they are the point here.
      // Both the source filter and the text patterns are scoped to the preview frame and to this origin.
      ignoreConsoleErrorsFromUrls: ['about:srcdoc'],
      expectedConsoleErrors: [/about:srcdoc/, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))],
    });
    const page = launched.window;
    await createWorkspace(page, 'Preview');
    await createProject(page, 'Pages');
    await createApi(page, 'Site', origin);
    await createRestRequest(page, 'Site', 'Hostile');
    await setMethodAndUrl(page, 'GET', '/page');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');
    expect(seen).toEqual(['GET /page']);

    await page.getByTestId('rest-response-view-preview').click();
    await expect(page.getByTestId('rest-response-html-preview')).toHaveAttribute('sandbox', '');
    const frame = page.frameLocator('[data-testid="rest-response-html-preview"]');
    await expect(frame.locator('h1[data-marker="static"]')).toHaveText('Preview content');

    const appUrl = page.url();
    const appTitle = await page.title();
    // The link targets the app window; it must not navigate it, and the frame keeps its document.
    await frame.locator('#away').click({ force: true });
    // The form's own submit button, without script: the sandbox and the CSP must refuse it.
    await frame.locator('#go').click({ force: true });
    // Deliberate fixed wait: this test proves that nothing happens, and an absence has no event to
    // await. It gives a refresh, a submit or a navigation time to happen.
    await page.waitForTimeout(1_500);

    await expect(frame.locator('h1[data-marker="static"]')).toHaveText('Preview content');
    expect(page.url()).toBe(appUrl);
    expect(await page.title()).toBe(appTitle);
    // The inline script and onload set the frame's title, not the app window's: neither ran.
    const child = page.frames().find((candidate) => candidate.url() === 'about:srcdoc');
    expect(child, 'the preview frame is still the srcdoc document').toBeDefined();
    expect(child!.url()).toBe('about:srcdoc');
    expect(await child!.title()).toBe('Original title');
    // The only request the server ever saw is the send itself.
    expect(seen).toEqual(['GET /page']);
  });
});
