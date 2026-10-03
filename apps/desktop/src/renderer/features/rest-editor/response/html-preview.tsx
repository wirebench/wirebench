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
