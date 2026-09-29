/**
 * `validate` (spec §2, R6): a SOAP message against the WSDL's XSD and SOAP rules, with line and
 * column; a REST response body against its OpenAPI response schema, with the JSON path and keyword.
 */
import { bindingContextFor, createRestContractChecker, findStepRequest, validateMessage } from '@wirebench/engine';
import type { HistoryEntry, Project, RestContractStatus } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { resolveOperation, soapRef } from './operation-refs.js';
import { clarkToQName, openProject } from './project.js';
import { exactlyOneSource, loadMessage, SOURCE_MESSAGE, sourceFields } from './sources.js';

export interface ValidateProblem {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  /** Counted on the redacted text the message was read as, so after a masked password on its line it is off by the marker's length. */
  readonly column?: number;
  /** An element path (SOAP) or a JSON Pointer (REST). */
  readonly path?: string;
}

export type ValidateResult =
  | {
      readonly kind: 'soap';
      readonly operation: string;
      readonly direction: 'request' | 'response';
      /** No error-severity problem. */
      readonly valid: boolean;
      readonly problems: readonly ValidateProblem[];
    }
  | {
      readonly kind: 'rest';
      readonly operation: string;
      readonly direction: 'response';
      readonly status: number;
      /** `ok` and `violation` were checked; the others say why nothing was. */
      readonly contract: RestContractStatus;
      /** True only when the body was checked and matched. */
      readonly valid: boolean;
      readonly problems: readonly ValidateProblem[];
      readonly notes: readonly string[];
    };

const input = z
  .object({
    operation: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Interface/Operation or API/operationId, as operations lists them; optional for a History entry of a saved request',
      ),
    ...sourceFields,
    status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe("REST: the response status whose schema applies; a History entry's own status by default, else 200"),
  })
  .refine(exactlyOneSource, { message: SOURCE_MESSAGE });

/** The operation a History entry's saved request belongs to, when it still exists. */
function operationOfEntry(project: Project, entry: HistoryEntry | undefined): string | undefined {
  if (entry?.requestId === undefined) {
    return undefined;
  }
  const lookup = findStepRequest(project, entry.requestId);
  if (lookup.kind !== 'found') {
    return undefined;
  }
  const { selected } = lookup;
  if (selected.kind === 'soap') {
    return soapRef(selected.iface, selected.operation);
  }
  return selected.kind === 'rest' ? selected.path : undefined;
}

export const validateOp = defineOp({
  name: 'validate',
  title: 'Validate a message',
  description:
    'Validates a SOAP message against the WSDL schema (problems with line and column) or a REST response ' +
    'body against its OpenAPI response schema (problems with JSON path and keyword). Reads a History entry, ' +
    'a file or the text itself: pass exactly one of historyId, file, text. Reads only.',
  input,
  async run(value, context): Promise<ValidateResult> {
    const { project } = await openProject(context);
    const message = await loadMessage(value, context);
    const ref = value.operation ?? operationOfEntry(project, message.entry);
    if (ref === undefined) {
      throw new OpsError('invalid-input', 'operation is required unless historyId names a send of a saved request');
    }
    const resolved = await resolveOperation(project, context.projectDir, ref);

    if (resolved.kind === 'soap') {
      const binding = bindingContextFor(
        resolved.wsdl.definition,
        { bindingName: clarkToQName(resolved.operation.bindingName), operationName: resolved.operation.name },
        message.direction,
      );
      if (binding === undefined) {
        throw new OpsError('operation-not-found', `"${resolved.ref}" is not an operation of a SOAP binding`, {
          operation: resolved.ref,
        });
      }
      const validated = await validateMessage({
        xml: message.text,
        direction: message.direction,
        schemaSet: resolved.wsdl.schemaSet,
        bundle: resolved.wsdl.bundle,
        binding,
        ...(message.contentType !== undefined ? { http: { contentType: message.contentType } } : {}),
      });
      return {
        kind: 'soap',
        operation: resolved.ref,
        direction: message.direction,
        valid: !validated.problems.some((problem) => problem.severity === 'error'),
        problems: validated.problems.map((problem) => ({
          severity: problem.severity,
          code: problem.code,
          message: problem.message,
          ...(problem.line !== undefined ? { line: problem.line } : {}),
          ...(problem.column !== undefined ? { column: problem.column } : {}),
          ...(problem.path !== undefined ? { path: problem.path } : {}),
        })),
      };
    }

    if (message.direction === 'request') {
      throw new OpsError('invalid-input', 'REST validation checks responses only; drop direction or pass response');
    }
    const status = value.status ?? message.entry?.status ?? 200;
    const checker = createRestContractChecker();
    try {
      const checked = await checker.check({
        status,
        contentType: message.contentType,
        bodyText: message.text,
        // The kind sources.ts decided from the text; the declared media type still picks the response schema.
        language: message.kind,
        streamed: false,
        operation: { method: resolved.operation.method, path: resolved.operation.path },
        responses: resolved.operation.responses,
      });
      return {
        kind: 'rest',
        operation: resolved.ref,
        direction: 'response',
        status,
        contract: checked.status,
        valid: checked.status === 'ok',
        problems: checked.problems.map((problem) => ({
          severity: 'error' as const,
          code: problem.keyword,
          message: problem.message,
          path: problem.path,
        })),
        notes: checked.notes,
      };
    } finally {
      await checker.dispose();
    }
  },
});
