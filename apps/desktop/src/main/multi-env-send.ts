/**
 * `request.sendToEnvironments`: one saved request sent under several of its project's
 * environments in parallel, each resolved exactly as a normal send would be with that environment
 * active — endpoint or base URL, property expansion (credentials included), TLS — while the active
 * environment is left as it is.
 *
 * Every child goes through the same path a single send takes (`sendAndRecordHistory` for SOAP,
 * `sendRestRequest` for REST), so History and the HTTP Log get one row per environment. The only
 * thing that differs is the project surface those paths read: {@link underEnvironment} answers
 * `scopesFor` for the chosen environment and names the History entry after it.
 */

import { isWirebenchError, WirebenchError } from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import { sendRestRequest, withRequestProperties, type RequestChannelDeps } from './ipc/request.js';
import { sendAndRecordHistory } from './send-with-history.js';
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
export function cancelEnvironmentBatch(service: EngineService, batchId: string): { cancelled: boolean } | undefined {
  const children = batches.get(batchId);
  if (children === undefined) {
    return undefined;
  }
  let cancelled = false;
  for (const sendId of children) {
    cancelled = service.cancel(sendId).cancelled || cancelled;
  }
  return { cancelled };
}

/** Appends the environment's name, so a History entry says which environment it went to. */
function named<T extends { requestName: string }>(meta: T | undefined, envName: string): T | undefined {
  return meta === undefined ? undefined : { ...meta, requestName: `${meta.requestName} · ${envName}` };
}

/**
 * The project surface a child send reads, with the scopes resolved for `envId` rather than the
 * active environment and the History names carrying the environment's name. Everything else is
 * the router's own.
 */
function underEnvironment(
  project: RequestChannelDeps['project'],
  envId: string,
  envName: string,
): RequestChannelDeps['project'] {
  const overrides: Partial<Record<PropertyKey, unknown>> = {
    scopesFor: (requestId: string) => project.scopesFor(requestId, envId),
    requestMeta: (requestId: string) => named(project.requestMeta(requestId), envName),
    ...(project.restMeta !== undefined
      ? { restMeta: (requestId: string) => named(project.restMeta?.(requestId), envName) }
      : {}),
  };
  return new Proxy(project, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property];
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
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
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestSendToEnvironmentsRequest,
  envId: string,
  envName: string,
): Promise<EnvSendResult> {
  const sendId = childSendId(request.batchId, envId);
  const envDeps: RequestChannelDeps = { ...deps, project: underEnvironment(deps.project, envId, envName) };
  const base = { outcome: 'ok', environmentId: envId, environmentName: envName } as const;
  if (request.soap !== undefined) {
    const mapped = deps.project.sendInputFor(
      request.requestId,
      {
        envelopeXml: request.soap.envelopeXml,
        ...(request.soap.headers !== undefined ? { headers: { ...request.soap.headers } } : {}),
      },
      envId,
    );
    if (mapped === undefined) {
      return errorResult(
        envId,
        envName,
        new WirebenchError('no-endpoint', `No endpoint resolves for this request under "${envName}"`),
      );
    }
    const effective = await withRequestProperties(
      envDeps.project,
      { sendId, requestId: request.requestId, input: mapped },
      envId,
    );
    const soap = await sendAndRecordHistory(service, envDeps, effective);
    return { ...base, kind: 'soap', soap };
  }
  const rest = await sendRestRequest(
    service,
    envDeps,
    { sendId, requestId: request.requestId, ...(request.restDraft !== undefined ? { draft: request.restDraft } : {}) },
    undefined,
    envId,
  );
  return { ...base, kind: 'rest', rest };
}

/**
 * Sends `request` under each of its environments in parallel. A request carrying `soap` is sent
 * as SOAP, any other as REST. Each environment settles on its own — one failing, or one the
 * project does not have, never stops the others — and the results come back in the order asked.
 */
export async function sendToEnvironments(
  service: EngineService,
  deps: RequestChannelDeps,
  request: RequestSendToEnvironmentsRequest,
): Promise<RequestSendToEnvironmentsResponse> {
  const owner = deps.project.projectId(request.requestId);
  const environments = owner === undefined ? [] : (deps.project.projectSnapshot?.(owner)?.environments ?? []);
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
            new WirebenchError('unknown-environment', `The project has no environment "${envId}"`),
          );
        }
        try {
          return await sendOne(service, deps, request, envId, envName);
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
