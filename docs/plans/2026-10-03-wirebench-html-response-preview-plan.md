# HTML response preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Preview tab of `BodyView` renders an HTML body statically, in an `<iframe sandbox="" srcdoc>`. No scripts, forms, navigation or network. It works for REST responses and webhook captures.

**Architecture:** A shared policy string (`src/shared/html-preview-csp.ts`) is prepended to the body as a `<meta>` CSP by a pure `previewDocument`. A new `HtmlPreview` component renders the sandboxed frame. `PreviewView` gains an `html` branch. In the main process, a `will-frame-navigate` guard denies every subframe navigation, as defence in depth.

**Tech Stack:** Electron 44, React, TypeScript, Vitest with Testing Library, Playwright (e2e, CI only).

**Spec:** `docs/specs/2026-10-03-wirebench-html-response-preview-design.md` (issue #48).

## Global Constraints

- The frame's `sandbox` attribute is exactly `""`. No `allow-*` token, ever.
- `HTML_PREVIEW_CSP` is exactly `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'`.
- `previewDocument(html)` returns `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">` followed by `html`, unchanged.
- Preview never decodes bytes. It uses `exchange.text`.
- Over `rest.prettyPrintMaxBytes` (judged by `exchange.text.length`, the same test Pretty uses): "Too large to preview. Raw shows the markup." and no frame.
- The note above the frame reads exactly: "Static preview: scripts, forms and remote resources are off."
- HTML still opens in Pretty. Only images open in Preview.
- The renderer imports nothing from `src/main/`. Shared code lives in `src/shared/`. The renderer imports only types from `shared/wire-types.ts`.
- Never name which product inspired a feature (`pnpm check:banned-terms`).
- `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit. One commit per task, subject ending `(#48)`. No `Co-Authored-By` or `Claude-Session` trailer. No local e2e: e2e runs in CI only.

## File map

| File | Change |
|---|---|
| `apps/desktop/src/shared/html-preview-csp.ts` | Create: `HTML_PREVIEW_CSP` |
| `apps/desktop/src/main/security.ts` | Add `denySubframeNavigation` |
| `apps/desktop/src/main/windows.ts` | Wire `will-frame-navigate` |
| `apps/desktop/test/security-baseline.test.ts` | Snapshot and guard tests |
| `apps/desktop/src/renderer/features/rest-editor/response/html-preview.tsx` | Create: `previewDocument`, `HtmlPreview` |
| `apps/desktop/src/renderer/features/rest-editor/response/body-view.tsx` | `PreviewView` html branch |
| `apps/desktop/test/renderer/html-preview.test.tsx` | Create |
| `apps/desktop/test/renderer/capture-viewer.test.tsx` | One case |
| `e2e/specs/html-preview.spec.ts` | Create |
| docs: REST guide, `docs/security.md`, CHANGELOG, roadmap | Task 4 |

## Tasks

### Task 1: The policy constant and the subframe navigation guard

**Files:**
- Create: `apps/desktop/src/shared/html-preview-csp.ts`
- Modify: `apps/desktop/src/main/security.ts`, `apps/desktop/src/main/windows.ts` (after the `will-navigate` handler, ~line 73)
- Test: `apps/desktop/test/security-baseline.test.ts`

**Interfaces:**
- Produces: `export const HTML_PREVIEW_CSP: string` (from `src/shared/html-preview-csp.ts`); `export function denySubframeNavigation(event: { readonly isMainFrame: boolean; preventDefault(): void }): void` (from `src/main/security.ts`).

- [ ] **Step 1: Write the failing tests** — add to `security-baseline.test.ts` (import `HTML_PREVIEW_CSP` from `'../src/shared/html-preview-csp.js'` and `denySubframeNavigation` from `'../src/main/security.js'`):

```ts
  it('keeps the HTML preview offline and inert', () => {
    expect(HTML_PREVIEW_CSP).toMatchInlineSnapshot(
      `"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"`,
    );
  });

  it('denies every subframe navigation and leaves the main frame to will-navigate', () => {
    const navigation = (isMainFrame: boolean) => {
      let prevented = false;
      return {
        isMainFrame,
        preventDefault: () => {
          prevented = true;
        },
        get prevented() {
          return prevented;
        },
      };
    };
    const sub = navigation(false);
    denySubframeNavigation(sub);
    expect(sub.prevented).toBe(true);
    const main = navigation(true);
    denySubframeNavigation(main);
    expect(main.prevented).toBe(false);
  });
```

- [ ] **Step 2: Run to see it fail.** `pnpm vitest run apps/desktop/test/security-baseline.test.ts`. It fails to resolve `html-preview-csp.js`.

- [ ] **Step 3: Implement.**

`apps/desktop/src/shared/html-preview-csp.ts`:

```ts
/**
 * The policy an HTML preview document carries (#48), on top of the app CSP a `srcdoc` frame
 * inherits. No script source and no network source: only inline styles and `data:` images and
 * fonts render. A file of its own, shared by both processes, so importing it pulls in nothing else.
 */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
```

`security.ts`, after `isExternalUrlAllowed`:

```ts
/**
 * `will-frame-navigate` handler: no subframe may navigate (#48). The app has no frame of its own
 * that navigates; the HTML preview's frame must stay on its document whatever its markup does.
 * The main frame is `will-navigate`'s.
 */
export function denySubframeNavigation(event: { readonly isMainFrame: boolean; preventDefault(): void }): void {
  if (!event.isMainFrame) {
    event.preventDefault();
  }
}
```

`windows.ts`: import `denySubframeNavigation` with the other `./security.js` imports, and after the `will-navigate` handler add:

```ts
  win.webContents.on('will-frame-navigate', denySubframeNavigation);
```

If Electron's typings reject passing the function directly (the event type is wider), wrap it: `win.webContents.on('will-frame-navigate', (event) => denySubframeNavigation(event));`.

- [ ] **Step 4: Run to see it pass.** Same command → PASS.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/html-preview-csp.ts apps/desktop/src/main/security.ts apps/desktop/src/main/windows.ts apps/desktop/test/security-baseline.test.ts
git commit -m "feat(desktop): an offline policy for the HTML preview, and no subframe navigation (#48)"
```

### Task 2: The preview in `BodyView`

**Files:**
- Create: `apps/desktop/src/renderer/features/rest-editor/response/html-preview.tsx`
- Modify: `apps/desktop/src/renderer/features/rest-editor/response/body-view.tsx` (`PreviewView`, ~line 296)
- Test: create `apps/desktop/test/renderer/html-preview.test.tsx`; add one case to `apps/desktop/test/renderer/capture-viewer.test.tsx`

**Interfaces:**
- Consumes: `HTML_PREVIEW_CSP` (Task 1; from the component it is `../../../../shared/html-preview-csp.js` — verify the depth with the typecheck).
- Produces: `export function previewDocument(html: string): string`; `export function HtmlPreview(props: { readonly html: string })`.

- [ ] **Step 1: Write the failing tests** — `apps/desktop/test/renderer/html-preview.test.tsx`, modelled on `capture-viewer.test.tsx`'s setup (same `vi.mock` lines for Monaco, `installWirebenchApi`, preferences store):

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { BodyView, type BodyViewExchange } from '../../src/renderer/features/rest-editor/response/body-view.js';
import { previewDocument } from '../../src/renderer/features/rest-editor/response/html-preview.js';
import { HTML_PREVIEW_CSP } from '../../src/shared/html-preview-csp.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const PAGE = '<!doctype html><html><body><h1>Hello</h1><script>document.title="ran"</script></body></html>';

const exchange = (patch: Partial<BodyViewExchange> = {}): BodyViewExchange => ({
  text: PAGE,
  language: 'html',
  http: { bodyBase64: btoa(PAGE), headers: { 'content-type': 'text/html; charset=utf-8' } },
  ...patch,
});

function mount(value: BodyViewExchange): void {
  render(
    <TooltipPrimitive.Provider>
      <BodyView exchange={value} />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  installWirebenchApi();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});
afterEach(() => {
  cleanup();
});

describe('previewDocument', () => {
  it('declares the policy and no-referrer before anything the server sent, and keeps the body as is', () => {
    const doc = previewDocument(PAGE);
    const head = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">`;
    expect(doc.startsWith(head)).toBe(true);
    expect(doc.slice(head.length)).toBe(PAGE);
  });
});

describe('BodyView preview of HTML (#48)', () => {
  it('still opens HTML in Pretty', () => {
    mount(exchange());
    expect(screen.getByTestId('rest-response-view-pretty').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('rest-response-html-preview')).toBeNull();
  });

  it('renders the body in a frame with an empty sandbox, and says what is off', () => {
    mount(exchange());
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    const frame = screen.getByTestId('rest-response-html-preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toBe(previewDocument(PAGE));
    expect(screen.getByText('Static preview: scripts, forms and remote resources are off.')).toBeTruthy();
  });

  it('does not render an HTML body over the size limit', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES_WIRE, rest: { ...DEFAULT_PREFERENCES_WIRE.rest, prettyPrintMaxBytes: 10 } },
      loaded: true,
    });
    mount(exchange());
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.queryByTestId('rest-response-html-preview')).toBeNull();
    expect(screen.getByText('Too large to preview. Raw shows the markup.')).toBeTruthy();
  });

  it('keeps the hex dump for other bodies', () => {
    mount(exchange({ text: 'plain', language: 'text', http: { bodyBase64: btoa('plain'), headers: {} } }));
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.getByTestId('rest-response-hex')).toBeTruthy();
    expect(screen.queryByTestId('rest-response-html-preview')).toBeNull();
  });
});
```

If `BodyViewExchange['language']` names the plain-text value differently from `'text'`, use the value the type allows for an unrecognised body. If the preferences store shape differs, set the limit the way an existing test does. Keep the assertions themselves as written.

The existing image path keeps its own coverage. If no test renders `rest-response-image` today, add one here: a `language: 'image'` exchange opens in Preview and renders `<img data-testid="rest-response-image">`. Stub `URL.createObjectURL` the way other renderer tests do, if needed.

Add to `capture-viewer.test.tsx`:

```tsx
  it('previews an HTML capture in a sandboxed frame', () => {
    const page = '<p>hi</p>';
    mount(capture({ contentType: 'text/html', text: page, language: 'html', bodyBase64: b64(page), bodySize: page.length }));
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.getByTestId('rest-response-html-preview').getAttribute('sandbox')).toBe('');
  });
```

- [ ] **Step 2: Run to see them fail.** `pnpm vitest run apps/desktop/test/renderer/html-preview.test.tsx apps/desktop/test/renderer/capture-viewer.test.tsx`. They fail: `html-preview.js` cannot be found, and the preview case fails.

- [ ] **Step 3: Implement.**

`html-preview.tsx`:

```tsx
/**
 * The HTML preview (#48): the body in a frame whose sandbox grants nothing — no script, form,
 * popup, navigation or storage, an opaque origin — and whose document declares an offline policy
 * before the server's markup. See docs/specs/2026-10-03-wirebench-html-response-preview-design.md §4.
 */

import { HTML_PREVIEW_CSP } from '../../../../shared/html-preview-csp.js';

/** `html` with the preview policy declared before anything the server sent. */
export function previewDocument(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${html}`;
}

/** The body, rendered statically in a frame that may do nothing but draw. */
export function HtmlPreview({ html }: { readonly html: string }) {
  return (
    <div className="flex h-full flex-col">
      <p className="shrink-0 px-2 py-1 text-xs text-fg-subtle">
        Static preview: scripts, forms and remote resources are off.
      </p>
      <iframe
        data-testid="rest-response-html-preview"
        title="HTML preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={previewDocument(html)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
```

`body-view.tsx`:
- Import `HtmlPreview`.
- Pass `tooLarge={tooLargeToPretty}` where `PreviewView` is rendered (`<PreviewView exchange={exchange} tooLarge={tooLargeToPretty} />`), and add `readonly tooLarge: boolean` to its props.
- In `PreviewView`, before the `if (image)` return (and before any hooks only the image path needs; keep the hook order valid — hooks first, then branches):

```tsx
  if (exchange.language === 'html') {
    return tooLarge ? (
      <p className="p-3 text-sm text-fg-subtle">Too large to preview. Raw shows the markup.</p>
    ) : (
      <HtmlPreview html={exchange.text} />
    );
  }
```

- Update the file's header comment, where it says Preview renders an image and a hex dump for anything else: "Preview renders an image, HTML in a sandboxed frame, and a hex dump for anything else."
- Do not change the default-mode logic: HTML still opens in Pretty.

- [ ] **Step 4: Run to see them pass.** Same command → PASS.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/features/rest-editor/response apps/desktop/test/renderer/html-preview.test.tsx apps/desktop/test/renderer/capture-viewer.test.tsx
git commit -m "feat(desktop): preview an HTML body in a sandboxed frame (#48)"
```

### Task 3: The hostile-page e2e test (CI only)

**Files:**
- Create: `e2e/specs/html-preview.spec.ts`

**Interfaces:**
- Consumes: the helpers in `e2e/helpers/launch-app.js`, `project.js` and `rest.js` (`createWorkspace`, `createProject`, `createApi`, `createRestRequest`, `setMethodAndUrl`, `sendRest`, `responseStatus`), and the testids `rest-response-view-preview` and `rest-response-html-preview` (Task 2).

Do **not** run this locally (no-local-e2e rule). Type-check it with the e2e package's typecheck, and lint it through `pnpm check`. CI runs it.

- [ ] **Step 1: Write the test.**

```ts
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
</head><body onload="document.title='onload-ran'">
<h1 data-marker="static">Preview content</h1>
<img src="${origin}/pixel.png" alt="">
<object data="${origin}/object.bin"></object>
<form id="f" action="${origin}/post" method="post"><input name="a" value="1"></form>
<script>document.title='script-ran'; document.getElementById('f').submit();</script>
<a id="away" href="${origin}/away" target="_top">away</a>
</body></html>`;
}

test.describe('HTML preview (#48)', () => {
  let launched: LaunchedApp | undefined;
  let server: Server | undefined;
  const seen: string[] = [];

  test.afterEach(async () => {
    await launched?.close();
    launched = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    seen.length = 0;
  });

  test('renders statically: no script, no request, no navigation', async () => {
    let origin = '';
    server = createServer((request, response) => {
      seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(hostilePage(origin));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    launched = await launchApp();
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
    // Deliberate fixed wait: this test proves that nothing happens, and an absence has no event to
    // await. It gives a refresh, a submit or a navigation time to happen.
    await page.waitForTimeout(1_500);

    await expect(frame.locator('h1[data-marker="static"]')).toHaveText('Preview content');
    expect(page.url()).toBe(appUrl);
    expect(await page.title()).toBe(appTitle);
    // The only request the server ever saw is the send itself.
    expect(seen).toEqual(['GET /page']);
  });
});
```

The helper names and arguments must match `e2e/helpers/*.ts`; the first test in `e2e/specs/rest.spec.ts` is the model for the setup sequence. Adapt only the calls, never the assertions.

- [ ] **Step 2: Type-check and lint.** Run the e2e package typecheck, then the full gate. Expected: green. The test itself runs in CI.

- [ ] **Step 3: Commit.**

```bash
git add e2e/specs/html-preview.spec.ts
git commit -m "test(e2e): a hostile page in the HTML preview runs nothing and fetches nothing (#48)"
```

### Task 4: Documentation

**Files:**
- Modify: `docs-site/src/content/docs/guides/rest-client.mdx`, `docs/security.md`, `CHANGELOG.md`, `docs/roadmap.md`

- [ ] **Step 1: REST guide.** Where the guide describes the response body views (Pretty, Raw, Preview), add:

```mdx
**Preview** also renders an HTML body, as a static page: scripts do not run, forms do not submit,
links do not navigate, and nothing the page points at is fetched — inline styles and embedded
(`data:`) images still show. A page that relies on external stylesheets therefore looks unstyled.
HTML still opens in Pretty; switch to Preview when you want to see it rendered. Webhook captures
preview the same way.
```

- [ ] **Step 2: `docs/security.md`.** Read the file's structure. Add a short "HTML preview" entry in the section about the renderer or the CSP, matching its style:
  - the sandboxed `srcdoc` frame (empty sandbox, opaque origin);
  - the preview policy (quote `HTML_PREVIEW_CSP`);
  - the `will-frame-navigate` guard;
  - the residual risk (a Chromium sandbox escape).

  Point at the spec's §4 for the full threat table.

- [ ] **Step 3: CHANGELOG and roadmap.**
  - `CHANGELOG.md`, Unreleased → Added: "**HTML preview.** The Preview tab renders an HTML response or webhook capture as a static page in a sandboxed frame: no scripts, forms, navigation or network (#48)."
  - `docs/roadmap.md` item 8: note that the HTML preview shipped (#48). Edit the status cell's wording minimally.

- [ ] **Step 4: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs-site docs/security.md CHANGELOG.md docs/roadmap.md
git commit -m "docs: the HTML response preview (#48)"
```
