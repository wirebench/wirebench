/**
 * Adding recorded traffic to a mock (#60, spec §Saving): each recording becomes one response of the
 * operation it routed to, after the ones the operation has. Pure: the caller saves the mock it gets
 * back, and the save adds one response file and one body file per stub.
 */

import { generateId } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';
import { MOCK_LIMITS, createMockOperation, createMockResponse } from './model.js';
import type { MockBodyLanguage, MockDef, MockHeader, MockOperation, MockResponse } from './model.js';

/** One upstream response the recorder kept, already masked. */
export interface MockRecording {
  /** The contract operation's key, as `operation.yaml` names it. */
  readonly operation: string;
  /** The contract's display name for it, used for an operation the mock does not have yet. */
  readonly operationName: string;
  readonly status: number;
  readonly headers: readonly MockHeader[];
  readonly body: MockBodyLanguage;
  readonly bodyText: string;
}

export interface AddRecordedStubsOptions {
  /** An operation that gets a recording loses its other responses. Default false. */
  readonly replace?: boolean;
  /** Skip a recording equal to a response the operation already has. Default true. */
  readonly dedupe?: boolean;
  readonly newId?: () => string;
}

/** Why a recording was not added. */
export type RecordedStubSkip = 'duplicate' | 'responses' | 'operations' | 'bodies';

export interface RecordedStubs {
  readonly mock: MockDef;
  readonly added: number;
  readonly skipped: readonly { readonly operation: string; readonly reason: RecordedStubSkip }[];
}

function bodyBytes(response: Pick<MockResponse, 'bodyText'>): number {
  return Buffer.byteLength(response.bodyText, 'utf8');
}

function operationBytes(operation: MockOperation): number {
  return operation.responses.reduce((sum, response) => sum + bodyBytes(response), 0);
}

function sameStub(response: MockResponse, recording: MockRecording): boolean {
  return (
    response.status === recording.status &&
    response.body === recording.body &&
    response.bodyText === recording.bodyText &&
    response.headers.length === recording.headers.length &&
    response.headers.every(
      (header, i) => header.name === recording.headers[i]?.name && header.value === recording.headers[i]?.value,
    )
  );
}

/** `Recorded <status>`, then `Recorded <status> 2`, …: unique among `taken` (lower-cased names). */
function uniqueName(status: number, taken: ReadonlySet<string>): string {
  const base = `Recorded ${String(status)}`;
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${String(n)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function nextOrder(items: readonly { readonly order: number }[]): number {
  return items.reduce((highest, item) => Math.max(highest, item.order + 1), 0);
}

/**
 * `mock` with `recordings` added as stubs, in order (spec §Saving). The input is not changed.
 *
 * - A recording joins the operation with its key, or a new `sequence` operation named as the contract
 *   names it. An operation without a default takes its first recorded stub as the default.
 * - `dedupe` (default on) skips a recording equal to a response the operation already has, the ones
 *   added by this call included.
 * - `replace` empties an operation of its other responses the first time a recording reaches it.
 * - ADR-0021's limits skip a recording rather than fail: responses per operation, operations per
 *   mock, and the bytes of every body in the mock.
 */
export function addRecordedStubs(
  mock: MockDef,
  recordings: readonly MockRecording[],
  options: AddRecordedStubsOptions = {},
): RecordedStubs {
  const newId = options.newId ?? generateId;
  const dedupe = options.dedupe ?? true;
  const operations: MockOperation[] = [...mock.operations];
  /** Operations this call created or already emptied for `replace`, by key. */
  const fresh = new Set<string>();
  const skipped: { operation: string; reason: RecordedStubSkip }[] = [];
  let totalBytes = mock.operations.reduce((sum, operation) => sum + operationBytes(operation), 0);
  let added = 0;

  for (const recording of recordings) {
    const key = recording.operation;
    const index = operations.findIndex((operation) => operation.operation === key);
    let operation: MockOperation;
    let bytesFreed = 0;
    if (index === -1) {
      if (operations.length >= MOCK_LIMITS.operations) {
        skipped.push({ operation: key, reason: 'operations' });
        continue;
      }
      operation = createMockOperation(recording.operationName, key, {
        newId,
        slug: uniqueSlug(recording.operationName, new Set(operations.map((existing) => existing.slug))),
        order: nextOrder(operations),
      });
    } else {
      operation = operations[index] as MockOperation;
      if (options.replace === true && !fresh.has(key)) {
        bytesFreed = operationBytes(operation);
        operation = createMockOperation(operation.name, operation.operation, {
          id: operation.id,
          slug: operation.slug,
          order: operation.order,
          dispatch: operation.dispatch,
          ...(operation.script !== undefined ? { script: operation.script } : {}),
        });
      }
    }

    let reason: RecordedStubSkip | undefined;
    const bytes = bodyBytes(recording);
    if (dedupe && operation.responses.some((response) => sameStub(response, recording))) {
      reason = 'duplicate';
    } else if (operation.responses.length >= MOCK_LIMITS.responsesPerOperation) {
      reason = 'responses';
    } else if (totalBytes - bytesFreed + bytes > MOCK_LIMITS.totalBodyBytes) {
      reason = 'bodies';
    }
    if (reason !== undefined) {
      skipped.push({ operation: key, reason });
      continue;
    }

    const name = uniqueName(
      recording.status,
      new Set(operation.responses.map((response) => response.name.toLowerCase())),
    );
    const response = createMockResponse(name, {
      newId,
      slug: uniqueSlug(name, new Set(operation.responses.map((existing) => existing.slug))),
      order: nextOrder(operation.responses),
      status: recording.status,
      headers: recording.headers,
      body: recording.body,
      bodyText: recording.bodyText,
    });
    const updated: MockOperation = {
      ...operation,
      ...(operation.defaultResponseId === undefined ? { defaultResponseId: response.id } : {}),
      responses: [...operation.responses, response],
    };
    if (index === -1) operations.push(updated);
    else operations[index] = updated;
    fresh.add(key);
    totalBytes += bytes - bytesFreed;
    added += 1;
  }
  return { mock: { ...mock, operations }, added, skipped };
}
