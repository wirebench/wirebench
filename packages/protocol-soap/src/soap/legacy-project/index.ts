export { looksLikeLegacyProject } from './format.js';
export { MAX_LEGACY_PROJECT_BYTES, readLegacySoapProject } from './import.js';
export type { LegacyProjectSource } from './import.js';
export type * from './model.js';
export { parseLegacyProject } from './parse.js';
export { definitionRootOf, fetchDocumentFromCache } from './definition-fetcher.js';
export type { CacheFetchOptions } from './definition-fetcher.js';
export { formatLegacyImportReport, IMPORTED_SCRIPTS_DIR, mapLegacyProject, resolvedOperationsOf } from './map.js';
export type {
  LegacyImportReport,
  LegacyImportReportItem,
  LegacyMapContext,
  LegacyScriptFile,
  MappedLegacyProject,
  ResolvedLegacyInterface,
  ResolvedOperation,
} from './map.js';
