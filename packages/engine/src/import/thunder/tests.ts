/**
 * Thunder Client's declarative test rows as Wirebench assertions (spec 2026-10-15 §7.3, owner
 * decision 2): the status code, the response time, and a plain JSON path. Every other row has no
 * equivalent and is left to the caller to report.
 */

import type { Assertion } from '../../assert/model.js';
import type { TcTest } from './model.js';

/** `json.a.b[0]`: each step starts with a different character, so nothing backtracks. */
const JSON_QUERY = /^json((?:\.[\w$-]+|\[\d+\])+)$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** An expected value as the type it reads as: a boolean, a number, or the text. */
function scalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return NUMBER.test(value) ? Number(value) : value;
}

/** One test row as an assertion, or undefined when it has no Wirebench equivalent. */
export function assertionOfThunderTest(test: TcTest): Assertion | undefined {
  const value = test.value.trim();
  if (test.type === 'res-code') {
    return test.action === 'equal' && /^\d{3}$/.test(value) ? { type: 'status', equals: Number(value) } : undefined;
  }
  if (test.type === 'res-time') {
    return (test.action === '<' || test.action === '<=') && /^\d+$/.test(value)
      ? { type: 'sla', maxMs: Number(value) }
      : undefined;
  }
  if (test.type !== 'json-query') return undefined;
  const path = JSON_QUERY.exec(test.custom.trim())?.[1];
  if (path === undefined) return undefined;
  const base = { type: 'match' as const, language: 'jsonpath' as const, expression: `$${path}` };
  if (test.action === 'equal') return { ...base, equals: scalar(value) };
  if (test.action === 'contains') return { ...base, matches: value.replace(REGEX_SPECIAL, '\\$&') };
  return undefined;
}

/** A test row as the report names it. */
export function describeThunderTest(test: TcTest): string {
  return [test.type, test.custom, test.action, test.value].filter((part) => part !== '').join(' ');
}
