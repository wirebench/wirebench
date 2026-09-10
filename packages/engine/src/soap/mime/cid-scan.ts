/**
 * Finding the `cid:` references an envelope makes, without a DOM.
 *
 * Both MTOM and SwA key off the same syntactic rule SoapUI uses: an element whose text
 * content is *exactly* a `cid:` reference points at an attachment. Anything else — a
 * sentence that merely mentions `cid:`, an attribute, a mixed-content element — is left
 * alone. The tolerant scanner is used (rather than a strict parse) because a request being
 * edited is frequently not yet well-formed, and a half-typed envelope must still send.
 */

import { scanXml, type ScannedElement, type TextRange } from '../../xsd/xml-scan.js';

/** One `cid:` reference found in an envelope, with the range of the text that carries it. */
export interface CidReference {
  /** The reference without its `cid:` scheme, e.g. `A1@wirebench`. */
  readonly cid: string;
  /** Range of the element's text content, ready to be spliced over. */
  readonly range: TextRange;
}

/** What {@link findCidReferences} found. */
export interface CidScan {
  readonly references: readonly CidReference[];
  /** False when the envelope was too malformed to scan; callers then leave it untouched. */
  readonly scannable: boolean;
}

const CID_TEXT = /^cid:(.+)$/;

function walk(elements: readonly ScannedElement[], visit: (element: ScannedElement) => void): void {
  for (const element of elements) {
    visit(element);
    walk(element.children, visit);
  }
}

/** Visits every element of a scanned envelope, depth first, parents before children. */
export function forEachScannedElement(
  elements: readonly ScannedElement[],
  visit: (element: ScannedElement) => void,
): void {
  walk(elements, visit);
}

/**
 * Every element whose entire text content is a `cid:` reference, in document order.
 *
 * @param envelopeXml the envelope to scan
 */
export function findCidReferences(envelopeXml: string): CidScan {
  const scan = scanXml(envelopeXml);
  if (scan.problems.length > 0) {
    return { references: [], scannable: false };
  }
  const references: CidReference[] = [];
  forEachScannedElement(scan.elements, (element) => {
    const text = element.text;
    if (text === undefined) {
      return;
    }
    const match = CID_TEXT.exec(text.value.trim());
    if (match?.[1] !== undefined) {
      references.push({ cid: match[1], range: text.range });
    }
  });
  return { references, scannable: true };
}

/** Replaces `[start, end)` ranges in `text`, applying them right to left so offsets stay valid. */
export function spliceRanges(
  text: string,
  edits: readonly { readonly range: TextRange; readonly text: string }[],
): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.range.start - a.range.start)) {
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}
