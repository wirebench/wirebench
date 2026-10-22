/**
 * Lifting one value out of a step's response. Body expressions go through the same hardened path as
 * assertions (`fontoxpath`, `jsonpath-plus` in its safe mode, both on a worker with a time budget), so
 * nothing in a sequence file is evaluated any other way (ADR-0015, spec Rule 7).
 */

import { firstHeaderValue } from '../assert/header.js';
import { firstText } from '../assert/match.js';
import type { AssertionSubject } from '../assert/model.js';
import { parseSetCookie } from '../http/cookies.js';
import { evaluateWithTimeout } from '../xpath/evaluate-async.js';
import { collectNamespaces } from '../xpath/namespaces.js';
import { SEQUENCE_LIMITS } from './model.js';
import type { Transfer } from './model.js';

/** What one transfer found. */
export type ExtractedValue =
  | { readonly kind: 'value'; readonly value: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string };

/** The response's own prefix bindings, or none when the body is not XML that parses. */
function defaultNamespaces(bodyText: string): Record<string, string> {
  try {
    return collectNamespaces(bodyText);
  } catch {
    return {};
  }
}

async function fromBody(
  subject: AssertionSubject,
  transfer: Extract<Transfer, { from: 'body' }>,
): Promise<ExtractedValue> {
  const wantsJson = transfer.language === 'jsonpath';
  if (wantsJson && subject.bodyKind !== 'json') {
    return { kind: 'error', code: 'sequence-transfer-failed', message: 'jsonpath needs a JSON response body' };
  }
  if (!wantsJson && subject.bodyKind === 'other') {
    return {
      kind: 'error',
      code: 'sequence-transfer-failed',
      message: `${transfer.language} needs an XML or JSON response body`,
    };
  }
  const namespaces =
    transfer.namespaces ?? (subject.bodyKind === 'xml' && !wantsJson ? defaultNamespaces(subject.bodyText) : undefined);
  const result = await evaluateWithTimeout(
    subject.bodyText,
    transfer.expression,
    { language: transfer.language, ...(namespaces !== undefined ? { namespaces } : {}) },
    { kind: subject.bodyKind === 'json' ? 'json' : 'xml' },
  );
  if (result.kind === 'error') {
    return { kind: 'error', code: 'sequence-transfer-failed', message: result.message };
  }
  const text = firstText(result);
  return text === undefined ? { kind: 'missing' } : { kind: 'value', value: text };
}

/**
 * Evaluates one transfer against a response. Never throws. A value over
 * {@link SEQUENCE_LIMITS.valueBytes} is an error rather than a value, so a server cannot make a run
 * hold (or send onward) more than that per name.
 */
export async function extractTransfer(subject: AssertionSubject, transfer: Transfer): Promise<ExtractedValue> {
  let found: ExtractedValue;
  switch (transfer.from) {
    case 'body':
      found = await fromBody(subject, transfer);
      break;
    case 'header': {
      const value = firstHeaderValue(subject.headers, transfer.header);
      found = value === undefined ? { kind: 'missing' } : { kind: 'value', value };
      break;
    }
    case 'status':
      found = { kind: 'value', value: String(subject.status) };
      break;
    case 'cookie': {
      const set = parseSetCookie(subject.headers ?? []).filter(
        (cookie) => cookie.malformed !== true && cookie.name === transfer.cookie,
      );
      const last = set[set.length - 1];
      found = last === undefined ? { kind: 'missing' } : { kind: 'value', value: last.value };
      break;
    }
  }
  if (found.kind === 'value' && Buffer.byteLength(found.value, 'utf8') > SEQUENCE_LIMITS.valueBytes) {
    return {
      kind: 'error',
      code: 'sequence-value-too-large',
      message: `${transfer.name} is larger than ${SEQUENCE_LIMITS.valueBytes} bytes`,
    };
  }
  return found;
}
