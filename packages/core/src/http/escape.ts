/**
 * Escaping a value that is substituted into a body, by the language the body is written in.
 *
 * In `http/` because the REST, gRPC and WebSocket expansions all apply it, and a protocol folder
 * imports core and itself, never another protocol (protocol modules spec §7.2). `rest/model.ts`
 * re-exports {@link RawLanguage} and `rest/body.ts` re-exports {@link escapeForLanguage}.
 */

/** The languages a raw body can be edited and sent as. Picks the editor mode and a default type. */
export type RawLanguage = 'json' | 'xml' | 'text' | 'html' | 'javascript';

/**
 * XML- or JSON-escapes a value being substituted into a body, for the *escape properties* setting.
 *
 * Only the characters that would otherwise change the document's structure are touched. A JSON
 * body gets JSON string escaping (without the surrounding quotes, since the value is substituted
 * inside them); an XML body gets the five predefined entities; anything else is left alone,
 * because there is no general escape for `text/plain`.
 */
export function escapeForLanguage(value: string, language: RawLanguage | 'form'): string {
  if (language === 'json') {
    const json = JSON.stringify(value);
    return json.slice(1, -1);
  }
  if (language === 'xml' || language === 'html') {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  return value;
}
