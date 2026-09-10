/**
 * Builds the `wsu:Timestamp` element of an outgoing WS-Security header
 * (WS-Security 1.0 utility schema).
 */

import { DOMImplementation } from '@xmldom/xmldom';
import type { Element } from '@xmldom/xmldom';
import { NS } from '../../xml/namespaces.js';

/** What {@link buildTimestamp} needs. All time and identity comes in; nothing is read here. */
export interface BuildTimestampInput {
  /** Seconds between `Created` and `Expires`; `0` (or less) omits `Expires`. */
  readonly ttlSeconds: number;
  /** Emit `.SSS` fractional seconds rather than whole seconds. */
  readonly millisecondPrecision: boolean;
  readonly clock: () => Date;
  readonly uuid: () => string;
}

/**
 * Formats `date` as an XSD `dateTime` in UTC, with or without milliseconds.
 *
 * @param date the instant to format
 * @param millisecondPrecision include `.SSS`
 * @returns e.g. `2026-09-09T12:00:00Z` or `2026-09-09T12:00:00.250Z`
 */
export function formatWssDateTime(date: Date, millisecondPrecision: boolean): string {
  const iso = date.toISOString();
  return millisecondPrecision ? iso : `${iso.slice(0, 19)}Z`;
}

/**
 * Builds `<wsu:Timestamp wsu:Id="TS-…"><wsu:Created/>[<wsu:Expires/>]</wsu:Timestamp>`.
 *
 * @param input the TTL, precision and the injected clock/uuid
 * @returns a detached element owned by a fresh document
 */
export function buildTimestamp(input: BuildTimestampInput): Element {
  const doc = new DOMImplementation().createDocument(null, '', null);
  const timestamp = doc.createElementNS(NS.WSU, 'wsu:Timestamp');
  timestamp.setAttributeNS(NS.WSU, 'wsu:Id', `TS-${input.uuid()}`);
  const created = input.clock();
  const createdElement = doc.createElementNS(NS.WSU, 'wsu:Created');
  createdElement.appendChild(doc.createTextNode(formatWssDateTime(created, input.millisecondPrecision)));
  timestamp.appendChild(createdElement);
  if (input.ttlSeconds > 0) {
    const expiresElement = doc.createElementNS(NS.WSU, 'wsu:Expires');
    const expires = new Date(created.getTime() + input.ttlSeconds * 1000);
    expiresElement.appendChild(doc.createTextNode(formatWssDateTime(expires, input.millisecondPrecision)));
    timestamp.appendChild(expiresElement);
  }
  return timestamp;
}
