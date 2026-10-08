export type {
  ChangeSeverity,
  ContractChange,
  ContractChangeKind,
  ContractDiff,
  ContractDiffSummary,
  ContractFormat,
  ContractSide,
  MessageSide,
} from './model.js';
export { bySide, sortChanges, summarize } from './model.js';
export type { DiffSchemasOptions } from './schema-diff.js';
export { diffSchemas, MAX_COMPARISONS, sameSchema } from './schema-diff.js';
export { diffEndpoints } from './endpoints.js';
export {
  contractDiffJson,
  escapeMarkdownCell,
  renderContractDiffHtml,
  renderContractDiffMarkdown,
  summaryLine,
} from './render.js';
