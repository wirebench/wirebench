/**
 * The policy an HTML preview document carries (#48), on top of the app CSP a `srcdoc` frame
 * inherits. No script source and no network source: only inline styles and `data:` images and
 * fonts render. A file of its own, shared by both processes, so importing it pulls in nothing else.
 */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
