/**
 * A project of streams for the integration tests, written with the engine. Kept apart from
 * `helpers.ts`, which `scripts/cli-smoke.ts` imports under plain Node: the engine's test helpers
 * only load through vitest.
 */
import {
  apiDefinitionDir,
  createGrpcApi,
  createGrpcRequest,
  createProject,
  createWsApi,
  createWsRequest,
  createWsSavedMessage,
  saveProject,
  writeProtoDefinitionCache,
} from '@wirebench/engine';
import type { Assertion, GrpcMethodKind } from '@wirebench/engine';
import { readProtoFixture } from '@wirebench/engine/test-helpers';
/** One gRPC call a {@link writeStreamsProject} project saves on the fixture's greeter. */
export interface StreamCall {
  readonly name: string;
  readonly method: string;
  readonly kind: GrpcMethodKind;
  readonly message: unknown;
  readonly assertions?: readonly Assertion[];
}

/**
 * Saves a project of streams in `dir`: a WebSocket API `Chat` on `wsUrl` whose `Echo` request sends
 * `one` then `two` (no assertions, as a saved WebSocket request has none), and, when `grpcTarget` is
 * given, the greeter's `calls` under a gRPC API `Greeter` with its proto definition cached.
 */
export async function writeStreamsProject(
  dir: string,
  options: { readonly wsUrl: string; readonly grpcTarget?: string; readonly calls?: readonly StreamCall[] },
): Promise<void> {
  const project = {
    ...createProject('Streams', { id: 'p-streams' }),
    wsApis: [
      createWsApi('Chat', {
        id: 'api-chat',
        slug: 'chat',
        order: 0,
        url: options.wsUrl,
        requests: [
          createWsRequest('Echo', {
            id: 'ws-echo',
            url: '/echo',
            messages: [
              createWsSavedMessage('One', { id: 'm1', content: 'one' }),
              createWsSavedMessage('Two', { id: 'm2', content: 'two' }),
            ],
          }),
        ],
      }),
    ],
    grpcApis:
      options.grpcTarget === undefined
        ? []
        : [
            createGrpcApi('Greeter', {
              id: 'api-greeter',
              slug: 'greeter',
              order: 1,
              target: options.grpcTarget,
              tls: false,
              requests: (options.calls ?? []).map((call, order) => ({
                ...createGrpcRequest(call.name, {
                  id: `g-${call.name}`,
                  order,
                  service: 'wirebench.greet.Greeter',
                  method: call.method,
                  methodKind: call.kind,
                  message: JSON.stringify(call.message),
                }),
                assertions: call.assertions ?? [],
              })),
            }),
          ],
  };
  await saveProject(project, dir);
  if (options.grpcTarget !== undefined) {
    await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
      source: 'greeter.proto',
      roots: ['greeter.proto'],
    });
  }
}
