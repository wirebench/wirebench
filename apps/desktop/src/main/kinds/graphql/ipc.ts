/**
 * GraphQL's IPC channels (phase 6 spec §3.4): the GraphQL editor's `request.*` channels and the API
 * schema's `api.*` channels. GraphQL is a REST body kind, so REST's channel registration calls these,
 * and the schema itself is kept by REST's project host, per API.
 */
import { INTROSPECTION_QUERY, sdlFromIntrospection, sdlFromSchemaFile, WirebenchError } from '@wirebench/engine';
import type { GraphQLSchema } from 'graphql';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { channels } from '../../../shared/ipc.js';
import type { ApiChannelDeps } from '../../ipc/api.js';
import { registerHandler } from '../../ipc/register.js';
import type { RequestChannelDeps } from '../../ipc/request.js';
import { checkedImportSource } from '../../path-access.js';
import { redactUrl } from '../../redact.js';
import { sendThroughEngine, type SendThroughEngineDeps } from '../../send/exchange.js';
import { graphqlDiagnostics, graphqlHover, graphqlQueryCompletion, graphqlVariableCompletion } from './assist.js';

/** An API's GraphQL schema for the editor; none for no API, or one that cannot be read. */
async function editorSchema(deps: RequestChannelDeps, apiId: string | undefined): Promise<GraphQLSchema | undefined> {
  if (apiId === undefined) return undefined;
  return await deps.project.graphqlSchemaFor?.(apiId).catch(() => undefined);
}

/** The GraphQL editor's `request.*` channels (#77): fetching the schema, and its language features. */
export function registerGraphqlRequestChannels(sendDeps: SendThroughEngineDeps, deps: RequestChannelDeps): void {
  registerHandler(channels.request.graphqlIntrospect, async (request) => {
    const store = deps.project.setGraphqlSchema;
    if (store === undefined) {
      throw new WirebenchError('invalid-argument', 'No project can store a GraphQL schema here');
    }
    let answer: { readonly text: string; readonly status: number; readonly url: string } | undefined;
    // The request as edited, sent as a POST of the introspection query: quiet, so no script runs and
    // nothing reaches History or the HTTP Log.
    await sendThroughEngine(sendDeps, `graphql-introspect:${randomUUID()}`, request.requestId, {
      draft: {
        kind: 'rest',
        draft: {
          ...(request.draft ?? {}),
          method: 'POST',
          body: { kind: 'graphql', query: INTROSPECTION_QUERY, variables: '' },
        },
      },
      quiet: true,
      onSent: (sent) => {
        if (sent.exchange?.kind === 'rest') {
          const { rest } = sent.exchange;
          answer = { text: rest.text, status: rest.status, url: rest.request.url };
        }
      },
    });
    if (answer === undefined) {
      throw new WirebenchError('graphql-schema-invalid', 'The introspection query got no answer');
    }
    let document: unknown;
    try {
      document = JSON.parse(answer.text) as unknown;
    } catch {
      throw new WirebenchError(
        'graphql-schema-invalid',
        `The server did not answer the introspection query with JSON (HTTP ${String(answer.status)})`,
        { details: { status: answer.status } },
      );
    }
    // The server's own error, when it sent one, is the message: introspection switched off, say.
    const sdl = sdlFromIntrospection(document);
    return await store(request.apiId, sdl, redactUrl(answer.url, { show: false }));
  });
  registerHandler(channels.request.graphqlDiagnostics, async (request) =>
    graphqlDiagnostics(await editorSchema(deps, request.apiId), request),
  );
  registerHandler(channels.request.graphqlComplete, async (request) => ({
    items:
      request.target === 'query'
        ? graphqlQueryCompletion(await editorSchema(deps, request.apiId), request.query, request.line, request.column)
        : graphqlVariableCompletion(request),
  }));
  registerHandler(channels.request.graphqlHover, async (request) => ({
    markdown: graphqlHover(await editorSchema(deps, request.apiId), request.query, request.line, request.column),
  }));
}

/** A schema file above this is refused before it is read. */
const MAX_GRAPHQL_SCHEMA_BYTES = 20 * 1024 * 1024;

/** The API schema's `api.*` channels (#77): importing a schema file, and removing the schema. */
export function registerGraphqlApiChannels(deps: ApiChannelDeps): void {
  registerHandler(channels.api.importGraphqlSchema, async (request) => {
    const checked = await checkedImportSource(deps.projectDirs(), deps.picks, { kind: 'file', path: request.path });
    if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a file');
    const { size } = await stat(checked.path);
    if (size > MAX_GRAPHQL_SCHEMA_BYTES) {
      throw new WirebenchError('graphql-schema-invalid', 'The schema file is larger than 20 MB', {
        details: { size },
      });
    }
    const name = basename(checked.path);
    const sdl = sdlFromSchemaFile(await readFile(checked.path, 'utf8'), name);
    if (deps.router.setGraphqlSchema === undefined) throw new WirebenchError('invalid-argument', 'No project is open');
    return await deps.router.setGraphqlSchema(request.apiId, sdl, name);
  });
  registerHandler(channels.api.clearGraphqlSchema, async (request) => {
    await deps.router.clearGraphqlSchema?.(request.apiId);
    return {};
  });
}
