/**
 * Every error a client can see is `{ code, message }` (host spec §2, §3.3): the shape
 * `WirebenchError` already gives the desktop, so the sync backend maps codes without translation.
 * The HTTP status rides in `details.status`, the engine's convention for HTTP-shaped errors.
 */
import { WirebenchError } from '@wirebench/engine';
import { ZodError } from 'zod';

export interface ProblemBody {
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
}

export interface Problem {
  readonly status: number;
  readonly body: ProblemBody;
}

/** A `WirebenchError` that knows its HTTP status. */
export function problem(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
): WirebenchError {
  return new WirebenchError(code, message, { details: { ...details, status } });
}

export function toProblem(error: unknown): Problem {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: 'invalid-request',
        message: 'The request did not match the expected shape.',
        issues: error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      },
    };
  }
  if (error instanceof WirebenchError) {
    const status = typeof error.details?.status === 'number' ? error.details.status : 500;
    return { status, body: { code: error.code, message: error.message } };
  }
  return { status: 500, body: { code: 'internal', message: 'Internal error' } };
}
