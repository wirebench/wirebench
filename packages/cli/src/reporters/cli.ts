import { seconds } from '@wirebench/engine';
import type { RequestOutcome, RequestResult, RunResult } from '@wirebench/engine';
import type { Reporter } from './types.js';

export interface CliReporterOptions {
  readonly color: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  /** stdout is a terminal: progress lines such as the callback wait are shown. */
  readonly interactive?: boolean;
}

const MARK: Readonly<Record<RequestOutcome, string>> = { passed: '✓', failed: '✗', errored: '!', skipped: '-' };

/** SGR colour per outcome; only used when the caller decided the stream can show colour. */
const COLOUR: Readonly<Record<RequestOutcome, string>> = {
  passed: '[32m',
  failed: '[31m',
  errored: '[33m',
  skipped: '[2m',
};
const RESET = '[0m';

/**
 * The human report on stdout: one line per request as it finishes, the reasons for anything that
 * did not pass indented below it, and a summary line. Diagnostics belong on stderr, not here.
 */
export function createCliReporter(out: NodeJS.WritableStream, options: CliReporterOptions): Reporter {
  const paint = (outcome: RequestOutcome, text: string): string =>
    options.color ? `${COLOUR[outcome]}${text}${RESET}` : text;

  const detailLines = (result: RequestResult): string[] => {
    const lines: string[] = [];
    if (result.error !== undefined) {
      lines.push(`${result.error.code}: ${result.error.message}`);
    }
    for (const assertion of result.assertions) {
      if (assertion.outcome === 'passed') {
        if (options.verbose) {
          // A callback's message says which capture matched; other kinds have none when they pass.
          lines.push(
            `✓ ${assertion.label}${assertion.type === 'callback' && assertion.message !== undefined ? ` — ${assertion.message}` : ''}`,
          );
        }
        continue;
      }
      if (assertion.expected !== undefined || assertion.actual !== undefined) {
        lines.push(`${assertion.label} — expected ${assertion.expected ?? ''}, actual ${assertion.actual ?? ''}`);
      } else {
        lines.push(`${assertion.label} — ${assertion.message ?? assertion.outcome}`);
      }
    }
    // A sequence step's transfers: one that found nothing or failed always shows, a value only when verbose.
    for (const transfer of result.transfers ?? []) {
      if (transfer.outcome !== 'set') {
        lines.push(`→ ${transfer.name}: ${transfer.message ?? transfer.outcome}`);
      } else if (options.verbose) {
        lines.push(`→ ${transfer.name} = ${transfer.secret ? '(secret)' : (transfer.value ?? '')}`);
      }
    }
    // A script's log shows when verbose, or always for a request that did not pass (#63).
    if (options.verbose || result.outcome !== 'passed') {
      for (const line of result.scriptLog ?? []) {
        lines.push(`log: ${line}`);
      }
    }
    return lines;
  };

  return {
    onCallbackWaiting(path, waiting) {
      if (options.interactive !== true || options.quiet) {
        return;
      }
      for (const one of waiting) {
        out.write(`… ${path}  waiting for callback ${one.catchUrl}… (up to ${seconds(one.withinMs)} s)\n`);
      }
    },
    onRequestDone(result) {
      if (options.quiet && result.outcome === 'passed') {
        return;
      }
      const parts = [paint(result.outcome, `${MARK[result.outcome]} ${result.path}`)];
      if (result.status !== undefined) {
        parts.push(String(result.status));
      }
      if (result.durationMs !== undefined) {
        parts.push(`${Math.round(result.durationMs)} ms`);
      }
      if (result.unasserted && result.outcome !== 'skipped') {
        parts.push('(no assertions)');
      }
      if (result.scriptsOff === true) {
        parts.push('(scripts off)');
      }
      out.write(`${parts.join('  ')}\n`);
      for (const line of detailLines(result)) {
        out.write(`    ${line}\n`);
      }
    },
    onRunDone(result: RunResult) {
      const { passed, failed, errored, skipped, durationMs } = result.summary;
      out.write(
        `\n${passed} passed, ${failed} failed, ${errored} errored, ${skipped} skipped in ${(durationMs / 1000).toFixed(1)}s\n`,
      );
    },
  };
}
