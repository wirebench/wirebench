/**
 * Test-only XML helpers for callers outside the engine that need to parse or validate a document
 * without adding their own XML dependency (`packages/cli` has exactly one runtime dependency —
 * `@wirebench/engine` — so its tests borrow the engine's `@xmldom/xmldom` and `xmllint-wasm`
 * through this subpath instead of adding either as a devDependency).
 */
import { DOMParser } from '@xmldom/xmldom';
import type { Document } from '@xmldom/xmldom';
import { validateXML } from 'xmllint-wasm';

/** Parses an XML document string. Throws on a parse error via xmldom's default error handler. */
export function parseXmlDocument(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

/** The outcome of validating a document against a standalone XSD (not a WSDL-derived schema set). */
export interface XsdValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Validates `xml` against a single standalone XSD document using libxml2 (`xmllint-wasm`). */
export async function validateAgainstXsd(xml: string, xsd: string): Promise<XsdValidationResult> {
  const result = await validateXML({ xml: { fileName: 'document.xml', contents: xml }, schema: xsd });
  return { valid: result.valid, errors: result.errors.map((error) => error.message) };
}
