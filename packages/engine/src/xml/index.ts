/**
 * Browser-safe subpath export (`@wirebench/engine/xml`): pure text helpers
 * with no dependency on `@xmldom/xmldom` or any Node module, safe to bundle
 * into the Electron renderer.
 */
export { formatXml, type FormatXmlOptions, type FormatXmlResult } from './pretty.js';
export {
  elementPathAt,
  completionContextAt,
  type CompletionContext,
  type TextRange,
} from '../xsd/locate.js';
