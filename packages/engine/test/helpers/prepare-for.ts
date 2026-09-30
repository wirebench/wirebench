/**
 * Prepares a selected request with its own module's `prepare…` function, for the tests that look
 * at a prepared send. No engine code needs this dispatch: a module's `send` prepares for itself
 * (ADR-0017), which is why it is not an export.
 */
import { prepareGrpc } from '../../src/grpc/run.js';
import type { SelectedRequest } from '../../src/protocols.js';
import { prepareRest } from '../../src/rest/run.js';
import type { RunContext } from '../../src/run/context.js';
import { prepareSoap } from '../../src/soap/run.js';

/** What the three modules' `prepare…` functions resolve to, told apart by `kind`. */
export type Prepared =
  | Awaited<ReturnType<typeof prepareSoap>>
  | Awaited<ReturnType<typeof prepareRest>>
  | Awaited<ReturnType<typeof prepareGrpc>>;

/** @throws WirebenchError what the module's `prepare…` throws */
export function prepareFor(selected: SelectedRequest, context: RunContext): Promise<Prepared> {
  switch (selected.kind) {
    case 'soap':
      return prepareSoap(selected, context);
    case 'rest':
      return prepareRest(selected, context);
    case 'grpc':
      return prepareGrpc(selected, context);
  }
}
