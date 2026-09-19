import type { AssertionResult, RequestResult, RunResult } from '@wirebench/engine';
import { escapeXml } from './escape.js';

const attr = (name: string, value: string): string => ` ${name}="${escapeXml(value)}"`;
const seconds = (durationMs: number | undefined): string => ((durationMs ?? 0) / 1000).toFixed(3);

/** The message a failed or errored assertion reports, matching the `cli` reporter's own wording. */
function assertionMessage(assertion: AssertionResult): string {
  if (assertion.expected !== undefined || assertion.actual !== undefined) {
    return `${assertion.label} — expected ${assertion.expected ?? ''}, actual ${assertion.actual ?? ''}`;
  }
  return `${assertion.label} — ${assertion.message ?? assertion.outcome}`;
}

function renderSystemOut(result: RequestResult): string {
  if (result.exchange === undefined) {
    return '';
  }
  const text = `${result.exchange.request}\n\n${result.exchange.response}`;
  return `<system-out>${escapeXml(text)}</system-out>`;
}

function renderTestcase(result: RequestResult): string {
  const openAttrs = `${attr('classname', result.group)}${attr('name', result.name)}${attr('time', seconds(result.durationMs))}`;
  const body: string[] = [];
  for (const assertion of result.assertions) {
    if (assertion.outcome === 'failed') {
      body.push(`<failure${attr('message', assertionMessage(assertion))}${attr('type', assertion.type)}/>`);
    }
  }
  if (result.outcome === 'errored' && result.error !== undefined) {
    body.push(`<error${attr('type', result.error.code)}${attr('message', result.error.message)}/>`);
  }
  if (result.outcome === 'skipped') {
    body.push('<skipped/>');
  }
  body.push(renderSystemOut(result));
  const inner = body.filter((line) => line.length > 0).join('');
  return inner.length === 0 ? `<testcase${openAttrs}/>` : `<testcase${openAttrs}>${inner}</testcase>`;
}

interface SuiteCounts {
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
  readonly time: number;
}

function countsOf(requests: readonly RequestResult[]): SuiteCounts {
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let time = 0;
  for (const request of requests) {
    if (request.outcome === 'failed') {
      failures += 1;
    } else if (request.outcome === 'errored') {
      errors += 1;
    } else if (request.outcome === 'skipped') {
      skipped += 1;
    }
    time += (request.durationMs ?? 0) / 1000;
  }
  return { tests: requests.length, failures, errors, skipped, time };
}

function renderSuite(name: string, requests: readonly RequestResult[]): string {
  const counts = countsOf(requests);
  const open =
    `<testsuite${attr('name', name)}` +
    `${attr('tests', String(counts.tests))}${attr('failures', String(counts.failures))}` +
    `${attr('errors', String(counts.errors))}${attr('skipped', String(counts.skipped))}` +
    `${attr('time', counts.time.toFixed(3))}>`;
  return `${open}${requests.map(renderTestcase).join('')}</testsuite>`;
}

/**
 * Renders a JUnit XML report: one `<testsuite>` per operation or API folder (the request's
 * `group`), in first-seen order, one `<testcase>` per request. Pure — no I/O, no file access.
 */
export function renderJunit(result: RunResult): string {
  const { total, failed, errored, skipped, durationMs } = result.summary;
  const groups = new Map<string, RequestResult[]>();
  for (const request of result.requests) {
    const bucket = groups.get(request.group);
    if (bucket === undefined) {
      groups.set(request.group, [request]);
    } else {
      bucket.push(request);
    }
  }
  const suites = [...groups.entries()].map(([name, requests]) => renderSuite(name, requests)).join('');
  const root =
    `<testsuites${attr('tests', String(total))}${attr('failures', String(failed))}` +
    `${attr('errors', String(errored))}${attr('skipped', String(skipped))}${attr('time', (durationMs / 1000).toFixed(3))}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${root}${suites}</testsuites>\n`;
}
