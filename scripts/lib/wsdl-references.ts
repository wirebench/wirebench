/**
 * Pure helpers for discovering and resolving WSDL/XSD document references, used by
 * `scripts/fixtures-refresh.ts` to recursively download the files a WSDL depends on.
 */

// Matches any `<import ...>` or `<include ...>` element regardless of namespace prefix (or lack
// of one) — real-world WSDLs use `wsdl:`, `xsd:`, `s:`, or the default namespace, not just
// `wsdl:`/`xs:`. The local name must be exactly `import`/`include` (word boundary keeps this from
// matching e.g. `<importantNote>`).
const ELEMENT_PATTERN = /<(?:[A-Za-z_][\w.-]*:)?(?:import|include)\b([^>]*)>/g;
// Matches a `location="…"` or `schemaLocation="…"` attribute, single or double quoted, anywhere
// within the element's attribute text.
const ATTRIBUTE_PATTERN = /\b(?:location|schemaLocation)\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * Scans WSDL/XSD document text for `import`/`include` elements (of any namespace prefix, or none)
 * and extracts their `location`/`schemaLocation` reference, returning the referenced locations in
 * first-seen order with duplicates removed.
 */
export function extractReferences(xml: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const match of xml.matchAll(ELEMENT_PATTERN)) {
    const attributes = match[1] ?? '';
    const attributeMatch = ATTRIBUTE_PATTERN.exec(attributes);
    const location = attributeMatch?.[1] ?? attributeMatch?.[2];
    if (location !== undefined && !seen.has(location)) {
      seen.add(location);
      ordered.push(location);
    }
  }
  return ordered;
}

/**
 * Resolves a (possibly relative) reference location against the URL of the document that
 * referenced it, mirroring how a WSDL/XSD `location`/`schemaLocation` is resolved.
 */
export function resolveReferenceUrl(parentUrl: string, reference: string): string {
  return new URL(reference, parentUrl).toString();
}

/**
 * Derives a filesystem-safe filename for a downloaded URL, taking the last path segment and
 * stripping any query string. When `usedNames` already contains that name, a numeric suffix
 * (`-2`, `-3`, ...) is appended before the extension until a free name is found.
 */
export function deriveFilename(url: string, usedNames?: Set<string>): string {
  const { pathname } = new URL(url);
  const segment = pathname.split('/').filter(Boolean).pop() ?? 'file';
  const base = decodeURIComponent(segment);
  if (usedNames === undefined || !usedNames.has(base)) {
    return base;
  }
  const dotIndex = base.lastIndexOf('.');
  const stem = dotIndex > 0 ? base.slice(0, dotIndex) : base;
  const ext = dotIndex > 0 ? base.slice(dotIndex) : '';
  let counter = 2;
  let candidate = `${stem}-${counter}${ext}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${stem}-${counter}${ext}`;
  }
  return candidate;
}
