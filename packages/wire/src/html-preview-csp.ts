/**
 * The policy an HTML preview document carries (#48), on top of the app CSP a `srcdoc` frame
 * inherits. No script source and no network source: inline styles and `data:` images render, and
 * fonts fall back to the system fonts (the app CSP's `font-src 'self'` applies too, so a `data:`
 * font is blocked). A file of its own, shared by both processes, so importing it pulls in nothing else.
 */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
