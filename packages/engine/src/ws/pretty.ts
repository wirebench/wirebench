/**
 * Frame text pretty-printing for the WebSocket log: JSON is reformatted with `JSON.stringify`, XML
 * with the engine's tolerant formatter, and anything else is left as-is. Browser-safe: `formatXml`
 * (from `xml/pretty.ts`) never throws and pulls no `node:` import.
 */

import { formatXml } from '../xml/pretty.js';

/** The result of {@link prettyFrameText}: the detected language and the text to display. */
export interface PrettyFrameResult {
  readonly language: 'json' | 'xml' | 'text';
  readonly pretty: string;
}

/** Reformats a WebSocket frame's text for display, detecting JSON or XML, else leaving it as text. */
export function prettyFrameText(text: string): PrettyFrameResult {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { language: 'json', pretty: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      // Not valid JSON despite the leading bracket; fall through to the other checks.
    }
  }
  if (trimmed.startsWith('<')) {
    const formatted = formatXml(text);
    if (formatted.problem === undefined) {
      return { language: 'xml', pretty: formatted.text };
    }
  }
  return { language: 'text', pretty: text };
}
