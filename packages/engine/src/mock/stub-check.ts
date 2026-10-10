/**
 * Checking a mock's stubs against its contract (#325). A mock checks the requests it receives; this
 * checks the replies it would send, so a stub that drifted from the contract is found before a client
 * test passes against the mock and fails against the real service. Each protocol's facet runs the
 * checks a received response gets (`MockContract.checkStubs`).
 */

import { defaultRegistry } from '../protocols.js';
import { nodeFs } from '../project/fs.js';
import type { FsLike } from '../project/fs.js';
import type { Project } from '../project/model.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { MockProblem, MockStubInput } from './contract.js';
import type { MockOperation, MockResponse } from './model.js';
import { findMock, openMockContract, replyHeaders } from './server.js';

export interface CheckMockStubsInput {
  readonly project: Project;
  /** The project folder, for the definition cache. */
  readonly root: string;
  readonly mockId: string;
  readonly fs?: FsLike;
  readonly registry?: ProtocolRegistry;
}

/** One stub the contract does not allow. */
export interface MockStubFinding {
  readonly operationId: string;
  readonly operationName: string;
  /** The contract operation's key. */
  readonly operation: string;
  readonly responseId: string;
  readonly responseName: string;
  readonly status: number;
  /** Each with the code `mock-stub-invalid`; `in` says whether the status, a header or the body is at fault. */
  readonly problems: readonly MockProblem[];
}

export interface MockStubCheck {
  /** Stubs checked: every response of an operation the contract has. */
  readonly checked: number;
  /** The stubs that do not conform, in the mock's order. */
  readonly findings: readonly MockStubFinding[];
}

/**
 * Checks every stub of `input.mockId` against its contract, read offline from the definition cache.
 * A stub of an operation the contract does not have is not checked: starting the mock warns of it.
 *
 * @throws WirebenchError `mock-not-found`, and what opening the contract throws
 * (`mock-container-missing`, `mock-protocol-unsupported`, `mock-definition-missing`, `mock-binding-unknown`)
 */
export async function checkMockStubs(input: CheckMockStubsInput): Promise<MockStubCheck> {
  const mock = findMock(input.project, input.mockId);
  const contract = await openMockContract(
    input.project,
    mock,
    input.root,
    input.fs ?? nodeFs,
    input.registry ?? defaultRegistry(),
  );
  if (contract.checkStubs === undefined) return { checked: 0, findings: [] };
  const known = new Set(contract.operations.map((operation) => operation.key));
  const stubs: { readonly operation: MockOperation; readonly response: MockResponse }[] = [];
  for (const operation of mock.operations) {
    if (!known.has(operation.operation)) continue;
    for (const response of operation.responses) stubs.push({ operation, response });
  }
  const results = await contract.checkStubs(
    stubs.map(({ operation, response }): MockStubInput => ({
      operation: operation.operation,
      response,
      headers: replyHeaders(response, contract),
    })),
  );
  const findings: MockStubFinding[] = [];
  stubs.forEach(({ operation, response }, index) => {
    const problems = results[index] ?? [];
    if (problems.length === 0) return;
    findings.push({
      operationId: operation.id,
      operationName: operation.name,
      operation: operation.operation,
      responseId: response.id,
      responseName: response.name,
      status: response.status,
      problems,
    });
  });
  return { checked: stubs.length, findings };
}
