/**
 * How a recorded send's bodies are shown.
 *
 * A history entry stores whatever was sent and received as text, whichever protocol produced it, so
 * the viewer has to decide what it is looking at. It sniffs rather than trusting the entry's `kind`:
 * a REST request may well carry XML, and a SOAP one is always XML but may have been recorded before
 * `kind` existed at all (an entry with no `kind` is a SOAP entry — see the wire type).
 */
import { formatXml } from '@wirebench/engine/xml';
import type { EditorLanguage } from '../../editor/code-editor.js';

/** What a recorded body looks like: JSON, XML, or something neither. */
export function sniffLanguage(text: string): EditorLanguage {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return 'json';
  }
  if (trimmed.startsWith('<')) {
    return 'xml';
  }
  return 'text';
}

/**
 * A recorded body, pretty-printed in whatever it turns out to be.
 *
 * Text that does not parse is returned unchanged: a history entry is a record of what actually
 * crossed the wire, and rewriting it to look valid would misrepresent it.
 */
export function prettyPrintBody(text: string, indent = 2): string {
  const language = sniffLanguage(text);
  if (language === 'json') {
    try {
      return JSON.stringify(JSON.parse(text), null, indent);
    } catch {
      return text;
    }
  }
  if (language === 'xml') {
    const result = formatXml(text, { indent: ' '.repeat(indent) });
    return result.problem === undefined ? result.text : text;
  }
  return text;
}
