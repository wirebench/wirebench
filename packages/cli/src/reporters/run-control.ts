import type { RequestResult } from '@wirebench/engine';

/**
 * What a request's scripts asked of the run (#335), as one line every reporter shows: that they
 * skipped it, where the run went on, or that they ended it. Undefined when they asked for nothing.
 */
export function controlLine(result: RequestResult): string | undefined {
  const control = result.control;
  if (control === undefined) return undefined;
  const parts = [
    ...(control.skipped === true ? ['skipped by its script'] : []),
    ...(control.next === null ? ['ended the run'] : []),
    ...(typeof control.next === 'string' ? [`next: ${JSON.stringify(control.next)}`] : []),
  ];
  return parts.length === 0 ? undefined : `↳ ${parts.join(', ')}`;
}
