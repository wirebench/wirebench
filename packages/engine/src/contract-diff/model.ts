/**
 * The contract diff's model (#56 spec §2): two versions of one contract compared operation by
 * operation, each difference one change, classified breaking or compatible for an existing client.
 */

export type ChangeSeverity = 'breaking' | 'compatible';

/** The client writes the request and reads the response; which side decides who a change hurts (§3.3). */
export type MessageSide = 'request' | 'response';

export type ContractFormat = 'wsdl' | 'openapi';

export type ContractChangeKind =
  | 'operation-added'
  | 'operation-removed'
  | 'endpoint-added'
  | 'endpoint-removed'
  | 'endpoint-moved'
  | 'field-added'
  | 'field-removed'
  | 'field-required'
  | 'field-optional'
  | 'type-changed'
  | 'type-narrowed'
  | 'type-widened'
  | 'enum-values-added'
  | 'enum-values-removed'
  | 'constraint-narrowed'
  | 'constraint-widened'
  | 'media-type-added'
  | 'media-type-removed'
  | 'response-added'
  | 'response-removed'
  | 'soap-action-changed'
  | 'soap-version-changed'
  | 'style-changed'
  | 'security-changed';

export interface ContractChange {
  readonly kind: ContractChangeKind;
  readonly severity: ChangeSeverity;
  /** `Binding#Operation` (WSDL) or `METHOD /path` (OpenAPI); absent for a contract-wide change. */
  readonly operation?: string;
  /** Where inside the operation: `request.order.items[].sku`, `request.query.limit`, `response.200`. */
  readonly location?: string;
  /** One sentence: what was, what is. */
  readonly message: string;
}

/** One of the two contracts compared. */
export interface ContractSide {
  /** How the user named it: a path, a URL, `project:<name>`. */
  readonly label: string;
  readonly title?: string;
  readonly version?: string;
}

export interface ContractDiff {
  readonly format: ContractFormat;
  readonly old: ContractSide;
  readonly new: ContractSide;
  /** Operations both contracts have. */
  readonly operationsCompared: number;
  /** Breaking changes first; otherwise in the contracts' order. */
  readonly changes: readonly ContractChange[];
  /** What could not be compared: unresolved types, schemas JSON Schema cannot express. */
  readonly notes: readonly string[];
}

export interface ContractDiffSummary {
  readonly breaking: number;
  readonly compatible: number;
}

export function summarize(changes: readonly ContractChange[]): ContractDiffSummary {
  const breaking = changes.filter((change) => change.severity === 'breaking').length;
  return { breaking, compatible: changes.length - breaking };
}

/** Breaking changes first; the order within each severity is kept. */
export function sortChanges(changes: readonly ContractChange[]): ContractChange[] {
  return [
    ...changes.filter((change) => change.severity === 'breaking'),
    ...changes.filter((change) => change.severity === 'compatible'),
  ];
}

/** The severity of a change that hurts one side only (§3.3). */
export function bySide(side: MessageSide, onRequest: ChangeSeverity, onResponse: ChangeSeverity): ChangeSeverity {
  return side === 'request' ? onRequest : onResponse;
}
