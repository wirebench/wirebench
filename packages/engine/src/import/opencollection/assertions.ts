/**
 * OpenCollection's declarative assertions (`runtime.assertions`) in Wirebench's assertion
 * catalogue (spec §7.4): the status, the response time, and a JSON body path. Anything else has
 * no equivalent and is left to the caller to report.
 */

import type { Assertion } from '../../assert/model.js';
import type { OcAssertion } from './model.js';

/** The operators read, by both of their spellings. */
const OPERATORS: Readonly<Record<string, string>> = {
  eq: 'equals',
  equals: 'equals',
  neq: 'notEquals',
  notEquals: 'notEquals',
  lt: 'lessThan',
  lessThan: 'lessThan',
  contains: 'contains',
  isNull: 'isNull',
  isNotNull: 'isNotNull',
};
/** `res.body.a.b[0]`: each step starts with a different character, so nothing backtracks. */
const BODY_PATH = /^res\.body\.([\w$]+(?:\.[\w$]+|\[\d+\])*)$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** An expected value as the type it reads as: a boolean, a number, or the text. */
function scalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return NUMBER.test(value) ? Number(value) : value;
}

/** The Wirebench assertion for `a`, or undefined when it is disabled or has no equivalent. */
export function mapOcAssertion(a: OcAssertion): Assertion | undefined {
  if (a.disabled === true) return undefined;
  const op = Object.hasOwn(OPERATORS, a.operator) ? OPERATORS[a.operator] : undefined;
  const value = a.value ?? '';
  if (a.expression === 'res.status' && op === 'equals' && /^\d{3}$/.test(value)) {
    return { type: 'status', equals: Number(value) };
  }
  if (a.expression === 'res.responseTime' && op === 'lessThan' && /^\d+$/.test(value)) {
    return { type: 'sla', maxMs: Number(value) };
  }
  const path = BODY_PATH.exec(a.expression)?.[1];
  if (path === undefined) return undefined;
  const base = { type: 'match' as const, language: 'jsonpath' as const, expression: `$.${path}` };
  switch (op) {
    case 'equals':
      return { ...base, equals: scalar(value) };
    case 'isNull':
      return { ...base, exists: false };
    case 'isNotNull':
      return { ...base, exists: true };
    case 'contains':
      return { ...base, matches: value.replace(REGEX_SPECIAL, '\\$&') };
    default:
      return undefined;
  }
}
