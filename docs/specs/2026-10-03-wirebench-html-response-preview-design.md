# HTML response preview — design

Issue: [#48](https://github.com/wirebench/wirebench/issues/48). Roadmap item 8; REST client spec §Response pane.

## Goal

When a REST response or a captured webhook request carries HTML, the **Preview** tab shows it rendered.
It is a static rendering. No script runs, no form posts, nothing navigates, and nothing is fetched
from the network. The markup stays one click away in Pretty and Raw.

## Decisions (owner, 2026-10-03)

1. **Scripts never run.** There is no opt-in. This is a preview, not a browser.
2. **No remote resources.** Images, stylesheets and fonts the HTML points at are not loaded. Inline
   styles and `data:` images still render. A page that relies on external CSS looks unstyled, and a
   note says why.
3. **Scope: REST responses and webhook captures.** Both already render through `BodyView`.
4. **Pretty stays the default** for HTML. Nothing renders until the user opens Preview.

## Scope

- The Preview mode of `BodyView` (`apps/desktop/src/renderer/features/rest-editor/response/body-view.tsx`).
  The webhook capture viewer reuses it, so it gets the preview too.
- Bodies whose detected language is `html`. The engine already detects that from the content type
  (`text/html`, `application/xhtml+xml`), or by sniffing when the content type is missing or
  `text/plain`.

Not in scope: SOAP responses, which are envelopes rather than pages. Also out: the HTTP log, running
scripts, loading remote resources, printing, and "open in browser".

## Approach

The body renders in an `<iframe sandbox="" srcdoc="…">` inside the renderer.

Two alternatives were rejected:
- **A separate `WebContentsView` with its own offline session.** It would add a process boundary,
  but a native view laid over the React layout brings focus, resize and theming work. The sandboxed
  frame already gives everything decisions 1 and 2 ask for.
- **Sanitising the markup and inserting it into the renderer's own DOM.** Untrusted markup would
  sit in the privileged renderer, and one sanitiser bypass would reach the preload API.

## 1. The preview document

A pure function in a new file, `features/rest-editor/response/html-preview.tsx` (beside the component of §2):

```ts
/** `html` with the preview policy declared before anything the server sent. */
export function previewDocument(html: string): string;
```

`previewDocument` returns
`<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta name="referrer" content="no-referrer">`
followed by `html` unchanged. The meta tags come first, so the policy is in force before the
parser meets anything from the response. A meta tag before `<html>` is valid. The parser moves it
into `<head>`, and a policy declared that way applies to everything parsed after it.

`HTML_PREVIEW_CSP` is the policy the preview document carries. It sits on top of the app's own CSP,
which a `srcdoc` frame inherits (§3 says where the constant lives):

```ts
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
```

The text is the body `BodyView` already shows: `exchange.text`, decoded with the response's charset
by the engine. The preview never decodes bytes itself.

## 2. The frame

A new component, `HtmlPreview`, in the same folder:

```tsx
<iframe
  data-testid="rest-response-html-preview"
  title="HTML preview"
  sandbox=""
  referrerPolicy="no-referrer"
  srcDoc={previewDocument(exchange.text)}
  className="h-full w-full border-0 bg-white"
/>
```

- `sandbox=""` sets every sandbox flag and grants no exception. It never carries an `allow-*` token,
  and a test pins that.
- A one-line note sits above the frame: "Static preview: scripts, forms and remote resources are
  off."
- The frame's background is white, as a browser's is, so a page with no styles stays readable in the
  dark theme.

**Choosing what Preview shows.** `PreviewView` gains one branch:
- `language === 'image'`: the image, as today;
- `language === 'html'`: `HtmlPreview`;
- anything else: the hex dump, as today.

**Too large.** When `exchange.text.length` exceeds the `rest.prettyPrintMaxBytes` preference
(5 MB by default), Preview shows "Too large to preview. Raw shows the markup." and renders nothing.
That is the same threshold that disables Pretty.

**Default view.** Unchanged: HTML opens in Pretty. Only images open in Preview.

## 3. Main-process guard and the policy constant

Defence in depth, added in `apps/desktop/src/main/windows.ts` beside the existing `will-navigate`
guard:

```ts
win.webContents.on('will-frame-navigate', (event) => {
  if (!event.isMainFrame) event.preventDefault();
});
```

The app has no frame of its own that navigates. Denying every subframe navigation therefore costs
nothing, and it stops a navigation that slipped past the sandbox: a meta refresh, or a link click.
The handler is a one-line function exported from `security.ts` (`denySubframeNavigation`), so it is
unit-tested without Electron.

`HTML_PREVIEW_CSP` lives in a new file, `apps/desktop/src/shared/html-preview-csp.ts`, a single
exported string. It sits beside `os-theme-argument.ts`, which is the folder both processes already
share, so the renderer never imports from `main/`. Nothing else goes in that file, so importing it
pulls in no other code and avoids the wire-types CSP trap. The existing baseline test,
`security-baseline.test.ts`, gains an inline snapshot of the constant next to
`CONTENT_SECURITY_POLICY`.

## 4. Security review

The renderer is sandboxed and context-isolated. Its preload exposes the `wirebench` API to the main
frame's isolated world only (`contextBridge.exposeInMainWorld`), and `nodeIntegrationInSubFrames` is
off. A subframe document is untrusted content placed inside that renderer process.

| Threat | Control | Proven by |
|---|---|---|
| The page runs script | Sandbox without `allow-scripts`. The preview CSP has no `script-src`, so `default-src 'none'` applies. The app CSP forbids inline script too. | e2e: an inline `<script>` and an `onload` handler try to set a marker; it stays unset |
| Script reaches the app (`window.parent`, the preload API, IPC) | No script runs. Even if it did, the frame has an opaque origin (no `allow-same-origin`), so `parent` is cross-origin. The preload API exists only in the main frame's isolated world. | renderer test: no `allow-*` token on the frame |
| A request tells a server the response was opened (beacon, IP leak) | `default-src 'none'`, `img-src data:` and `font-src data:` block every fetch. `referrer` is `no-referrer`. | e2e: `<img>`, `<link rel=stylesheet>`, `@import`, CSS `url()` and `@font-face` all point at a local server, which records zero requests |
| A form posts data | Sandbox without `allow-forms`, plus `form-action 'none'` | e2e: an auto-submitting form sends nothing |
| The page navigates the frame or the app (link, meta refresh, `target=_top`) | Sandbox without `allow-top-navigation*`; the parent's `frame-src` (from `default-src 'self'`) refuses any other origin; the main-process `will-frame-navigate` guard denies every subframe navigation; `will-navigate` already denies the main frame | e2e: a meta refresh and a clicked link leave the frame on its document; unit: `denySubframeNavigation` |
| Popups, `window.open`, `target=_blank` | Sandbox without `allow-popups`; `setWindowOpenHandler` already denies everything | covered by the link-click case |
| A `<base href>` redirects relative URLs | `base-uri 'none'` | unit: part of the policy snapshot |
| `<object>`, `<embed>`, plugins | `default-src 'none'` covers `object-src`; the sandbox blocks plugins | e2e: an `<object data>` makes no request |
| CSS exfiltration through attribute selectors | Needs a network request, which the CSP blocks | covered by the beacon case |
| An oversized or pathological document freezes the pane | The `prettyPrintMaxBytes` cut-off. The frame's layout runs in the renderer, as Monaco does today. | renderer test: over the limit, no frame |
| A Chromium sandbox escape | Residual risk. It is mitigated by keeping Electron current, and it is the same exposure every Chromium-based tool has when it shows HTML | — |

**What stays allowed:** inline `<style>` and `style` attributes, `data:` images and `data:` fonts.
These are what the preview exists to show, and none of them can reach the network or run code.

## 5. Testing

- **Unit** (`test/renderer/html-preview.test.tsx`):
  - `previewDocument` puts the two meta tags first and leaves the body byte-for-byte unchanged after
    them.
- **Unit** (`security-baseline.test.ts`):
  - an inline snapshot of `HTML_PREVIEW_CSP`;
  - `denySubframeNavigation` prevents a subframe navigation and allows a main-frame one.
- **Renderer** (`test/renderer/html-preview.test.tsx`, and one case in `capture-viewer.test.tsx`):
  - Preview on an `html` body renders the frame, with `sandbox` exactly `""` and the note shown.
  - An image body still renders `<img>`.
  - Any other body still renders the hex dump.
  - An `html` body over the limit shows the too-large message and no frame.
  - HTML still opens in Pretty.
  - The webhook capture viewer's Preview renders the frame for an HTML capture.
- **e2e** (Playwright, CI only, per the no-local-e2e rule): one test sends a REST request to a local
  server that returns a hostile page, then opens Preview. The page carries:
  - an inline script and an `onload` handler that set `document.title`;
  - images, a stylesheet, an `@import`, a CSS `url()`, a font and an `<object>` that all point at
    the same local server;
  - an auto-submitting form;
  - a meta refresh;
  - a `target=_top` link, which the test clicks.

  The test asserts:
  - the frame's document is still the preview;
  - the app window has not navigated;
  - the server logged exactly one request: the send itself.

## 6. Documentation

- The REST client guide's response section: Preview renders HTML statically. Scripts, forms and
  remote resources are off, and here is why.
- `docs/security.md`: a short "HTML preview" entry with the threat table's controls.
- CHANGELOG, Unreleased/Added.
- `docs/roadmap.md` item 8: the HTML preview is shipped.
