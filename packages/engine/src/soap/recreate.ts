/**
 * SoapUI-style "Recreate Request": merge a freshly generated envelope
 * (the source of structure) with an existing edited envelope (the source of
 * values), by matching elements on a root-relative path of
 * `localName[siblingIndex]` steps rather than by DOM identity.
 */

import { scanXml, type ScannedElement } from '../xsd/xml-scan.js';
import { formatXml } from '../xml/pretty.js';

/** Options for {@link recreateRequest}. */
export interface RecreateOptions {
  /** Copy matching leaf values (text and attributes) from the current envelope. */
  readonly keepValues: boolean;
  /** Keep the current `<soapenv:Header>` content verbatim instead of the generated one. */
  readonly keepHeaders: boolean;
}

/** Result of {@link recreateRequest}. */
export interface RecreateResult {
  readonly xml: string;
  /** Leaf values copied from the current envelope. */
  readonly kept: number;
  /** Elements present only in the generated structure. */
  readonly added: number;
  /** Elements present in the current envelope but absent from the generated one. */
  readonly removed: number;
}

/** A path step: an element's local name plus its 1-based index among same-named siblings. */
type PathStep = string;

function pathKey(path: readonly PathStep[]): string {
  return path.join('/');
}

/** Builds a map from root-relative path → element, for every element in the tree(s). */
function indexByPath(roots: readonly ScannedElement[]): Map<string, ScannedElement> {
  const map = new Map<string, ScannedElement>();
  const walk = (elements: readonly ScannedElement[], parentPath: readonly PathStep[]): void => {
    const counts = new Map<string, number>();
    for (const el of elements) {
      const n = (counts.get(el.localName) ?? 0) + 1;
      counts.set(el.localName, n);
      const step = `${el.localName}[${n}]`;
      const path = [...parentPath, step];
      map.set(pathKey(path), el);
      walk(el.children, path);
    }
  };
  walk(roots, []);
  return map;
}

/** Counts every removed element in `current` (present, absent from `generated`) recursively. */
function countRemoved(
  currentRoots: readonly ScannedElement[],
  generatedIndex: Map<string, ScannedElement>,
  parentPath: readonly PathStep[],
): number {
  let removed = 0;
  const counts = new Map<string, number>();
  for (const el of currentRoots) {
    const n = (counts.get(el.localName) ?? 0) + 1;
    counts.set(el.localName, n);
    const step = `${el.localName}[${n}]`;
    const path = [...parentPath, step];
    if (generatedIndex.has(pathKey(path))) {
      removed += countRemoved(el.children, generatedIndex, path);
    } else {
      removed += 1 + countAll(el.children);
    }
  }
  return removed;
}

function countAll(elements: readonly ScannedElement[]): number {
  let n = 0;
  for (const el of elements) {
    n += 1 + countAll(el.children);
  }
  return n;
}

/** Splices `[value, at range]` replacements into `text`, applied back-to-front so ranges stay valid. */
function applyReplacements(text: string, replacements: readonly { start: number; end: number; value: string }[]): string {
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of sorted) {
    out = out.slice(0, r.start) + r.value + out.slice(r.end);
  }
  return out;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

/**
 * Merges `generatedXml` (structure) with `currentXml` (values), per SoapUI's
 * "Recreate Request" semantics.
 */
export function recreateRequest(currentXml: string, generatedXml: string, options: RecreateOptions): RecreateResult {
  const { keepValues, keepHeaders } = options;

  const currentScan = scanXml(currentXml);
  const generatedScan = scanXml(generatedXml);

  const currentEnvelope = currentScan.elements.find((e) => e.localName === 'Envelope');
  const generatedEnvelope = generatedScan.elements.find((e) => e.localName === 'Envelope');

  if (generatedEnvelope === undefined) {
    return { xml: formatXml(generatedXml).text, kept: 0, added: 0, removed: 0 };
  }
  if (currentEnvelope === undefined || !keepValues) {
    const removed = keepValues ? 0 : 0;
    return { xml: formatXml(generatedXml).text, kept: 0, added: countAll(generatedEnvelope.children), removed };
  }

  const currentIndex = indexByPath(currentEnvelope.children);
  const generatedIndex = indexByPath(generatedEnvelope.children);

  let kept = 0;
  const replacements: { start: number; end: number; value: string }[] = [];

  const walkGenerated = (elements: readonly ScannedElement[], parentPath: readonly PathStep[]): void => {
    const counts = new Map<string, number>();
    for (const el of elements) {
      const n = (counts.get(el.localName) ?? 0) + 1;
      counts.set(el.localName, n);
      const step = `${el.localName}[${n}]`;
      const path = [...parentPath, step];
      const key = pathKey(path);
      const currentEl = currentIndex.get(key);

      if (currentEl === undefined) {
        continue;
      }

      // Leaf element (no children in generated): copy text value if present in current.
      if (el.children.length === 0) {
        if (currentEl.text !== undefined && el.text !== undefined) {
          const currentValue = currentEl.text.value;
          const generatedValue = el.text.value;
          if (currentValue !== generatedValue) {
            replacements.push({ start: el.text.range.start, end: el.text.range.end, value: escapeXmlText(currentValue) });
          }
          kept += 1;
        }
      } else {
        walkGenerated(el.children, path);
      }

      // Attributes: copy matching attribute values from current.
      for (const attr of el.attributes) {
        const currentAttr = currentEl.attributes.find((a) => a.name === attr.name);
        if (currentAttr !== undefined && currentAttr.value !== attr.value) {
          replacements.push({ start: attr.valueRange.start, end: attr.valueRange.end, value: escapeXmlAttr(currentAttr.value) });
        }
      }
    }
  };

  walkGenerated(generatedEnvelope.children, []);

  let added = 0;
  const countAdded = (elements: readonly ScannedElement[], parentPath: readonly PathStep[]): void => {
    const counts = new Map<string, number>();
    for (const el of elements) {
      const n = (counts.get(el.localName) ?? 0) + 1;
      counts.set(el.localName, n);
      const step = `${el.localName}[${n}]`;
      const path = [...parentPath, step];
      if (currentIndex.has(pathKey(path))) {
        countAdded(el.children, path);
      } else {
        added += 1 + countAll(el.children);
      }
    }
  };
  countAdded(generatedEnvelope.children, []);

  const removed = countRemoved(currentEnvelope.children, generatedIndex, []);

  let mergedXml = applyReplacements(generatedXml, replacements);

  if (keepHeaders) {
    const currentHeader = currentEnvelope.children.find((e) => e.localName === 'Header');
    const generatedHeaderInMerged = scanXml(mergedXml).elements
      .find((e) => e.localName === 'Envelope')
      ?.children.find((e) => e.localName === 'Header');
    if (currentHeader !== undefined && generatedHeaderInMerged !== undefined) {
      const headerText = currentXml.slice(currentHeader.range.start, currentHeader.range.end);
      mergedXml =
        mergedXml.slice(0, generatedHeaderInMerged.range.start) +
        headerText +
        mergedXml.slice(generatedHeaderInMerged.range.end);
    }
  }

  return { xml: formatXml(mergedXml).text, kept, added, removed };
}
