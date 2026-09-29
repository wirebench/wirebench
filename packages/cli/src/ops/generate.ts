// packages/cli/src/ops/generate.ts
import { buildSampleRequest, sampleFromSchema } from '@wirebench/engine';
import type { OpenApiMediaType } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { resolveOperation } from './operation-refs.js';
import { clarkToQName, openProject } from './project.js';

export type GenerateResult =
  | {
      readonly kind: 'soap';
      readonly operation: string;
      readonly soapVersion: '1.1' | '1.2';
      readonly soapAction?: string;
      readonly contentType: string;
      /** Action-carrying headers (SOAP 1.1's `SOAPAction`). */
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      /** What the generator could not build. */
      readonly problems: readonly string[];
    }
  | {
      readonly kind: 'rest';
      readonly operation: string;
      readonly method: string;
      readonly path: string;
      readonly contentType?: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly note?: string;
    };

const input = z.object({
  operation: z
    .string()
    .min(1)
    .describe(
      'Interface/Operation, API/operationId, API/METHOD /path, or a saved request path, as operations lists them',
    ),
  optional: z
    .enum(['all', 'required'])
    .default('required')
    .describe('Include optional elements and properties (all), or only required ones (required, the default)'),
});

/** A JSON media type first, else the first one declared. */
function pickMedia(
  content: Readonly<Record<string, OpenApiMediaType>> | undefined,
): { readonly type: string; readonly media: OpenApiMediaType } | undefined {
  const types = Object.keys(content ?? {});
  const type = types.find((candidate) => candidate.toLowerCase().includes('json')) ?? types[0];
  const media = type === undefined ? undefined : content?.[type];
  return type === undefined || media === undefined ? undefined : { type, media };
}

export const generateOp = defineOp({
  name: 'generate',
  title: 'Generate a sample request',
  description:
    "Builds a sample request for one operation: a SOAP envelope from the WSDL's XSD, or a JSON body from the " +
    'OpenAPI schema, with method, path and headers for REST. Reads only; nothing is saved.',
  input,
  async run(value, context): Promise<GenerateResult> {
    const { project } = await openProject(context);
    const resolved = await resolveOperation(project, context.projectDir, value.operation);
    const includeOptional = value.optional === 'all';
    if (resolved.kind === 'soap') {
      const generated = buildSampleRequest(
        { definition: resolved.wsdl.definition, schemaSet: resolved.wsdl.schemaSet },
        { bindingName: clarkToQName(resolved.operation.bindingName), operationName: resolved.operation.name },
        { includeOptional, sampleValues: true },
      );
      return {
        kind: 'soap',
        operation: resolved.ref,
        soapVersion: generated.soapVersion,
        ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
        contentType: generated.contentType,
        headers: generated.headers,
        body: generated.envelopeXml,
        problems: generated.problems.map((problem) => problem.message),
      };
    }
    const base = {
      kind: 'rest' as const,
      operation: resolved.ref,
      method: resolved.operation.method.toUpperCase(),
      path: resolved.operation.path,
    };
    const chosen = pickMedia(resolved.operation.requestBody?.content);
    if (chosen === undefined) {
      return { ...base, headers: {} };
    }
    const headers = { 'Content-Type': chosen.type };
    if (!chosen.type.toLowerCase().includes('json')) {
      return {
        ...base,
        contentType: chosen.type,
        headers,
        note: `The body is ${chosen.type}; generate samples JSON bodies only`,
      };
    }
    const sample =
      chosen.media.example ?? sampleFromSchema(chosen.media.schema ?? {}, { includeOptional, sampleValues: true });
    return { ...base, contentType: chosen.type, headers, body: JSON.stringify(sample, null, 2) };
  },
});
