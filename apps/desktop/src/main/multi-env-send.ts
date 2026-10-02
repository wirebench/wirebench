/**
 * `request.sendToEnvironments`: one saved request sent under several of its project's
 * environments in parallel, each resolved exactly as a normal send would be with that environment
 * active — endpoint or base URL, property expansion (credentials included), TLS — while the active
 * environment is left as it is.
 *
 * Every child goes through the engine (`sendThroughEngine`), the path a single send takes, under its
 * own environment (`SendOptions.envId`), so History and the HTTP Log get one row per environment and
 * each History entry carries its environment's name (`SendOptions.environmentName`).
 */

import { isWirebenchError, WirebenchError } from '@wirebench/engine';
import type { RequestChannelDeps } from './ipc/request.js';
import { sendThroughEngine, type ExchangeRegistry, type SendThroughEngineDeps } from './send/exchange.js';
import type {
  EnvSendResult,
  RequestSendToEnvironmentsRequest,
  RequestSendToEnvironmentsResponse,
} from '../shared/wire-types.js';

/** The child send ids of every fan-out still running, keyed by its batch id. */
const batches = new Map<string, readonly string[]>();

/** The send id of one environment's child in a batch. */
function childSendId(batchId: string, envId: string): string {
  return `${batchId}:${envId}`;
}

/**
 * Cancels every child of the fan-out `batchId` still running. `undefined` when no such batch is
 * running, so `request.cancel` can fall through to an ordinary send id.
 */
export function cancelEnvironmentBatch(
  registry: ExchangeRegistry,
  batchId: string,
): { cancelled: boolean } | undefined {
  const children = batches.get(batchId);
  if (children === undefined) {
    return undefined;
  }
  let cancelled = false;
  for (const sendId of children) {
    cancelled = registry.cancel(sendId).cancelled || cancelled;
  }
  return { cancelled };
}

function errorResult(envId: string, envName: string, error: unknown): EnvSendResult {
  return {
    outcome: 'error',
    environmentId: envId,
    environmentName: envName,
    code: isWirebenchError(error) ? error.code : 'internal-error',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Sends one environment's child; throws what a single send would throw. */
async function sendOne(
  sendDeps: SendThroughEngineDeps,
  request: RequestSendToEnvironmentsRequest,
  envId: string,
  envName: string,
): Promise<EnvSendResult> {
  const sendId = childSendId(request.batchId, envId);
  const base = { outcome: 'ok', environmentId: envId, environmentName: envName } as const;
  const options = { envId, environmentName: envName } as const;
  if (request.soap !== undefined) {
    const headers = request.soap.headers !== undefined ? { headers: { ...request.soap.headers } } : {};
    // Refused as it always was, naming the environment, before anything is prepared.
    if (sendDeps.project.endpointFor(request.requestId, envId) === undefined) {
      return errorResult(
        envId,
        envName,
        new WirebenchError('no-endpoint', `No endpoint resolves for this request under "${envName}"`),
      );
    }
    // The editor's envelope and headers; the endpoint is the environment's.
    const soap = await sendThroughEngine(sendDeps, sendId, request.requestId, {
      ...options,
      draft: { kind: 'soap', override: { envelopeXml: request.soap.envelopeXml, ...headers } },
    });
    return { ...base, kind: 'soap', soap };
  }
  const rest = await sendThroughEngine(sendDeps, sendId, request.requestId, {
    ...options,
    draft: { kind: 'rest', ...(request.restDraft !== undefined ? { draft: request.restDraft } : {}) },
  });
  return { ...base, kind: 'rest', rest };
}

/**
 * Sends `request` under each of its environments in parallel. A request carrying `soap` is sent
 * as SOAP, any other as REST. Each environment settles on its own — one failing, or one the
 * project does not have, never stops the others — and the results come back in the order asked.
 */
export async function sendToEnvironments(
  sendDeps: SendThroughEngineDeps,
  deps: Pick<RequestChannelDeps, 'project'>,
  request: RequestSendToEnvironmentsRequest,
): Promise<RequestSendToEnvironmentsResponse> {
  // The environments that apply to the request: the workspace's inside a workspace, else its
  // project's. A router without `sendEnvironments` (a stub) falls back to the project's own.
  const owner = deps.project.projectId(request.requestId);
  const environments =
    deps.project.sendEnvironments?.(request.requestId).environments ??
    (owner === undefined ? [] : (deps.project.projectSnapshot?.(owner)?.environments ?? []));
  const nameOf = (envId: string): string | undefined =>
    environments.find((environment) => environment.id === envId)?.name;

  batches.set(
    request.batchId,
    request.environmentIds.map((envId) => childSendId(request.batchId, envId)),
  );
  try {
    const settled = await Promise.allSettled(
      request.environmentIds.map(async (envId) => {
        const envName = nameOf(envId);
        if (envName === undefined) {
          return errorResult(
            envId,
            envId,
            new WirebenchError('unknown-environment', `No environment "${envId}" applies to this request`),
          );
        }
        try {
          return await sendOne(sendDeps, request, envId, envName);
        } catch (error) {
          return errorResult(envId, envName, error);
        }
      }),
    );
    return {
      results: settled.map((outcome, index) => {
        const envId = request.environmentIds[index] ?? '';
        return outcome.status === 'fulfilled'
          ? outcome.value
          : errorResult(envId, nameOf(envId) ?? envId, outcome.reason);
      }),
    };
  } finally {
    batches.delete(request.batchId);
  }
}
