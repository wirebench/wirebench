/**
 * The legacy single-XML SOAP project format's own identifiers.
 *
 * This file and `fixtures/legacy-soap-project/` are the only tracked paths exempt from
 * `pnpm check:banned-terms`: the namespace URI and root element name below have to be written out
 * verbatim to recognise the format, and they contain names the check otherwise forbids. Keep
 * everything else — comments included — out of this file, and never let these strings reach UI text.
 */

/** The namespace every element of the format lives in. */
export const LEGACY_PROJECT_NAMESPACE = 'http://eviware.com/soapui/config';

/** The local name of the document element. */
export const LEGACY_PROJECT_ROOT = 'soapui-project';

/**
 * A cheap check on the first few kilobytes of `text`, for import auto-detection: the root element's
 * local name and the namespace both have to appear. `parseLegacyProject` is the real test.
 */
export function looksLikeLegacyProject(text: string): boolean {
  const head = text.slice(0, 4096);
  return (
    head.includes(LEGACY_PROJECT_NAMESPACE) && new RegExp(`<(?:[\\w.-]+:)?${LEGACY_PROJECT_ROOT}[\\s>]`).test(head)
  );
}
