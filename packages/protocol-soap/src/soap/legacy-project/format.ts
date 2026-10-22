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

const ESCAPED_NAMESPACE = LEGACY_PROJECT_NAMESPACE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const NAMESPACE_DECLARATION = new RegExp(`\\sxmlns(?::[\\w.-]+)?\\s*=\\s*(["'])${ESCAPED_NAMESPACE}\\1`);
const ROOT_ELEMENT = new RegExp(`<(?:[\\w.-]+:)?${LEGACY_PROJECT_ROOT}[\\s>]`);

/**
 * A cheap check on the first few kilobytes of `text`, for import auto-detection: the root element's
 * local name has to appear, and the format's namespace has to be declared in an `xmlns` attribute.
 * `parseLegacyProject` is the real test.
 */
export function looksLikeLegacyProject(text: string): boolean {
  const head = text.slice(0, 4096);
  return ROOT_ELEMENT.test(head) && NAMESPACE_DECLARATION.test(head);
}
