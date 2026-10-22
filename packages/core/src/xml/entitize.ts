/**
 * Escaping a value that lands inside XML text.
 *
 * In `xml/` because property expansion (`project/properties.ts`) applies it for every protocol,
 * and core imports no protocol folder (protocol modules spec §7.2). `soap/transforms.ts` re-exports
 * it beside the envelope transforms it has always sat with.
 */

/**
 * "Entitize Properties", applied to one substituted property value: escapes the three
 * characters that would otherwise be read as markup once the value lands inside an envelope.
 *
 * `"` and `'` are deliberately left alone: expansion targets element content far more often
 * than an attribute value, and escaping quotes there would show up as `&quot;` in the payload.
 *
 * @param value the expanded property value
 */
export function entitizeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
