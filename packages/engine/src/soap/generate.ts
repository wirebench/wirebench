/**
 * Convenience wrappers around `buildSampleRequest`/`buildEmptyRequest` that
 * take a {@link WsdlImportResult} directly, so callers don't have to thread
 * `definition`/`schemaSet` through by hand.
 */

import { buildEmptyRequest, buildSampleRequest } from './request-builder.js';
import type { GeneratedRequest, OperationRef, RequestBuildOptions } from './request-builder.js';
import type { GenerateOptions } from '../xsd/sample-generator.js';
import type { WsdlImportResult } from './types.js';

/** Builds the sample SOAP request for one operation of an imported definition. */
export function generateSoapRequest(
  result: WsdlImportResult,
  op: OperationRef,
  genOptions?: Partial<GenerateOptions>,
  options?: RequestBuildOptions,
): GeneratedRequest {
  return buildSampleRequest({ definition: result.definition, schemaSet: result.schemaSet }, op, genOptions, options);
}

/** Builds an empty SOAP request (empty `Header`/`Body`) for one operation of an imported definition. */
export function generateEmptySoapRequest(
  result: WsdlImportResult,
  op: OperationRef,
  options?: RequestBuildOptions,
): GeneratedRequest {
  return buildEmptyRequest({ definition: result.definition, schemaSet: result.schemaSet }, op, options);
}
