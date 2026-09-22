import type { Attr, Document, Element, Node } from '@xmldom/xmldom';
import type { SnapshotChange } from './diff.js';
import { truncateValue } from './format.js';
import { parseXml } from '../xml/parse.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** The (namespace URI, local name) pair elements and attributes are compared by. */
function nameKey(namespaceURI: string | null, localName: string): string {
  return `${namespaceURI ?? ''}|${localName}`;
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function childElements(node: Element): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes.item(i);
    if (child !== null && isElement(child)) {
      result.push(child);
    }
  }
  return result;
}

/** Direct text (and CDATA) children, trimmed and concatenated — comments, PIs and whitespace-only text are ignored. */
function ownText(node: Element): string {
  let text = '';
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes.item(i);
    if (child !== null && (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE)) {
      text += child.nodeValue ?? '';
    }
  }
  return text.trim();
}

/** An element's non-`xmlns` attributes, keyed by (namespace, local name). */
function attributesOf(node: Element): Map<string, Attr> {
  const result = new Map<string, Attr>();
  for (let i = 0; i < node.attributes.length; i += 1) {
    const attr = node.attributes.item(i);
    if (attr === null) {
      continue;
    }
    if (attr.namespaceURI === XMLNS_NS || attr.nodeName === 'xmlns' || attr.nodeName.startsWith('xmlns:')) {
      continue;
    }
    result.set(nameKey(attr.namespaceURI, attr.localName ?? attr.nodeName), attr);
  }
  return result;
}

/** Groups an element's children by (namespace, local name), preserving document order within each group. */
function groupChildren(elements: readonly Element[]): Map<string, Element[]> {
  const groups = new Map<string, Element[]>();
  for (const element of elements) {
    const key = nameKey(element.namespaceURI, element.localName ?? element.tagName);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [element]);
    } else {
      group.push(element);
    }
  }
  return groups;
}

function elementDisplay(element: Element): string {
  return `<${element.localName ?? element.tagName}>`;
}

function childPath(parentPath: string, localName: string, indexInGroup: number, groupSize: number): string {
  const segment = groupSize > 1 ? `${localName}[${indexInGroup + 1}]` : localName;
  return `${parentPath}/${segment}`;
}

function diffAttributes(golden: Element, actual: Element, path: string, changes: SnapshotChange[]): void {
  const goldenAttrs = attributesOf(golden);
  const actualAttrs = attributesOf(actual);
  const keys = new Set([...goldenAttrs.keys(), ...actualAttrs.keys()]);
  for (const key of keys) {
    const goldenAttr = goldenAttrs.get(key);
    const actualAttr = actualAttrs.get(key);
    const attrPath = `${path}/@${(goldenAttr ?? actualAttr)?.localName ?? (goldenAttr ?? actualAttr)?.nodeName}`;
    if (goldenAttr !== undefined && actualAttr === undefined) {
      changes.push({ kind: 'removed', path: attrPath, expected: truncateValue(goldenAttr.value) });
    } else if (goldenAttr === undefined && actualAttr !== undefined) {
      changes.push({ kind: 'added', path: attrPath, actual: truncateValue(actualAttr.value) });
    } else if (goldenAttr !== undefined && actualAttr !== undefined && goldenAttr.value !== actualAttr.value) {
      changes.push({
        kind: 'changed',
        path: attrPath,
        expected: truncateValue(goldenAttr.value),
        actual: truncateValue(actualAttr.value),
      });
    }
  }
}

function diffChildren(golden: Element, actual: Element, path: string, changes: SnapshotChange[]): void {
  const goldenGroups = groupChildren(childElements(golden));
  const actualGroups = groupChildren(childElements(actual));
  const keys = new Set([...goldenGroups.keys(), ...actualGroups.keys()]);
  for (const key of keys) {
    const goldenGroup = goldenGroups.get(key) ?? [];
    const actualGroup = actualGroups.get(key) ?? [];
    const groupSize = Math.max(goldenGroup.length, actualGroup.length);
    const shared = Math.min(goldenGroup.length, actualGroup.length);
    const localName =
      (goldenGroup[0] ?? actualGroup[0])?.localName ?? (goldenGroup[0] ?? actualGroup[0])?.tagName ?? '';
    for (let i = 0; i < shared; i += 1) {
      const goldenChild = goldenGroup[i];
      const actualChild = actualGroup[i];
      if (goldenChild !== undefined && actualChild !== undefined) {
        diffElement(goldenChild, actualChild, childPath(path, localName, i, groupSize), changes);
      }
    }
    for (let i = shared; i < goldenGroup.length; i += 1) {
      const goldenChild = goldenGroup[i];
      if (goldenChild !== undefined) {
        changes.push({
          kind: 'removed',
          path: childPath(path, localName, i, groupSize),
          expected: elementDisplay(goldenChild),
        });
      }
    }
    for (let i = shared; i < actualGroup.length; i += 1) {
      const actualChild = actualGroup[i];
      if (actualChild !== undefined) {
        changes.push({
          kind: 'added',
          path: childPath(path, localName, i, groupSize),
          actual: elementDisplay(actualChild),
        });
      }
    }
  }
}

function diffElement(golden: Element, actual: Element, path: string, changes: SnapshotChange[]): void {
  diffAttributes(golden, actual, path, changes);

  const goldenText = ownText(golden);
  const actualText = ownText(actual);
  if (goldenText !== actualText) {
    changes.push({ kind: 'changed', path, expected: truncateValue(goldenText), actual: truncateValue(actualText) });
  }

  diffChildren(golden, actual, path, changes);
}

/**
 * Semantically diffs two XML documents per the "Semantic diff" spec
 * section: elements/attributes compared by namespace URI + local name (so
 * prefixes don't matter), `xmlns` declarations/attribute order/comments/PIs
 * ignored, whitespace-only text ignored and other text trimmed, and
 * repeated same-name siblings paired in order (so an earlier sibling with a
 * different name doesn't shift the rest).
 */
export function diffXml(golden: string, actual: string): SnapshotChange[] {
  const goldenDoc: Document = parseXml(golden);
  const actualDoc: Document = parseXml(actual);
  const goldenRoot = goldenDoc.documentElement;
  const actualRoot = actualDoc.documentElement;

  if (goldenRoot === null || actualRoot === null) {
    return [];
  }

  const goldenKey = nameKey(goldenRoot.namespaceURI, goldenRoot.localName ?? goldenRoot.tagName);
  const actualKey = nameKey(actualRoot.namespaceURI, actualRoot.localName ?? actualRoot.tagName);
  const rootName = goldenRoot.localName ?? goldenRoot.tagName;
  const changes: SnapshotChange[] = [];

  if (goldenKey !== actualKey) {
    changes.push({
      kind: 'changed',
      path: `/${rootName}`,
      expected: elementDisplay(goldenRoot),
      actual: elementDisplay(actualRoot),
    });
    return changes;
  }

  diffElement(goldenRoot, actualRoot, `/${rootName}`, changes);
  return changes;
}
