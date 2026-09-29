import type { OpName } from '../args-ops.js';
import type { AnyOp } from './context.js';
import { generateOp } from './generate.js';
import { historyDiffOp, historyListOp } from './history.js';
import { importOp } from './import.js';
import { operationsOp } from './operations.js';
import { queryOp } from './query.js';
import { sendOp } from './send.js';
import { validateOp } from './validate.js';

/** Every op, keyed by its tool name, in the order `tools/list` shows them. */
export const OPS: Readonly<Record<OpName, AnyOp>> = {
  import: importOp,
  operations: operationsOp,
  generate: generateOp,
  send: sendOp,
  validate: validateOp,
  query: queryOp,
  history_list: historyListOp,
  history_diff: historyDiffOp,
};
