/**
 * `@wirebench/engine/snapshot`: the pure semantic diff behind snapshot
 * regression (issue #34). Compares a golden response body against a newly
 * received one, structurally for JSON and XML and exactly for everything
 * else, honouring per-request ignore rules.
 */
export { diffSnapshot, type SnapshotFormat, type SnapshotChange, type SnapshotDiff } from './diff.js';
export { detectSnapshotFormat } from './format.js';
export { matchesIgnoreRule, parseIgnoreRules } from './ignore.js';
