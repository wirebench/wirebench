/**
 * Pure helpers for discovering and resolving WSDL/XSD document references, used by
 * `scripts/fixtures-refresh.ts` to recursively download the files a WSDL depends on.
 */

const REFERENCE_PATTERNS: readonly RegExp[] = [
  /<[^>]*\bwsdl:import\b[^>]*\blocation\s*=\s*"([^"]+)"[^>]*>/g,
  /<[^>]*\bxs:import\b[^>]*\bschemaLocation\s*=\s*"([^"]+)"[^>]*>/g,
  /<[^>]*\bxs:include\b[^>]*\bschemaLocation\s*=\s*"([^"]+)"[^>]*>/g,
];

/**
 * Scans WSDL/XSD document text for `wsdl:import` and `xs:import`/`xs:include` references,
 * returning the referenced locations in first-seen order with duplicates removed.
 */
export function extractReferences(xml: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const pattern of REFERENCE_PATTERNS) {
    for (const match of xml.matchAll(pattern)) {
      const location = match[1];
      if (location !== undefined && !seen.has(location)) {
        seen.add(location);
        ordered.push(location);
      }
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
