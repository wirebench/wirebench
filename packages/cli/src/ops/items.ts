/**
 * The saved request `send` takes: its item path as `operations` lists it (or as `wirebench run`
 * selects it, on disk or displayed), else its name when only one request has it.
 */
import { selectRequests } from '@wirebench/engine';
import type { Project, SelectedRequest } from '@wirebench/engine';
import { OpsError } from './errors.js';

export type SendableItem = Extract<SelectedRequest, { kind: 'soap' | 'rest' }>;

/** A container the project's folder holds and this build did not load. */
type Placeholder = NonNullable<Project['unsupported']>[number];

function isSendable(item: SelectedRequest): item is SendableItem {
  return item.kind === 'soap' || item.kind === 'rest';
}

/** The refusal of a request `send` cannot take: a gRPC or a WebSocket one. */
function notSendable(item: SelectedRequest): OpsError {
  const kind = item.kind === 'grpc' ? 'gRPC' : 'WebSocket';
  return new OpsError('unsupported-kind', `"${item.path}" is a ${kind} request; send takes SOAP and REST requests`, {
    item: item.path,
  });
}

function ambiguous(ref: string, items: readonly SelectedRequest[]): OpsError {
  return new OpsError(
    'item-ambiguous',
    `"${ref}" names ${String(items.length)} requests; pass one path: ${items.map((item) => item.path).join(', ')}`,
    { item: ref },
  );
}

/** The placeholder `ref` points into: by its display name, or by its folder on disk. */
function placeholderFor(project: Project, ref: string): Placeholder | undefined {
  return (project.unsupported ?? []).find((container) => {
    const label = container.name ?? container.slug;
    const folder = `${container.dir}/${container.slug}`;
    return ref === label || ref.startsWith(`${label}/`) || ref === folder || ref.startsWith(`${folder}/`);
  });
}

/**
 * Requests `send` cannot take (gRPC, WebSocket) are set aside before any ambiguity is judged, so a
 * name a REST request shares with one of them still resolves to the REST request. A reference only
 * they match is refused as `unsupported-kind`.
 *
 * @throws OpsError `item-not-found`, `item-ambiguous`, `unsupported-kind`
 */
export function resolveItem(project: Project, ref: string): SendableItem {
  const { selected: covered } = selectRequests(project, [ref]);
  const selected = covered.filter(isSendable);
  const exact = selected.filter((item) => item.path === ref);
  if (exact.length === 1 && exact[0] !== undefined) {
    return exact[0];
  }
  if (selected.length === 1 && selected[0] !== undefined) {
    return selected[0];
  }
  if (selected.length > 1) {
    throw ambiguous(ref, selected);
  }
  const allNamed = selectRequests(project, []).selected.filter((item) => item.request.name === ref);
  const named = allNamed.filter(isSendable);
  if (named.length === 1 && named[0] !== undefined) {
    return named[0];
  }
  if (named.length > 1) {
    throw ambiguous(ref, named);
  }
  // Nothing send takes matched; something it cannot take did.
  const other = covered.find((item) => item.path === ref) ?? covered[0] ?? allNamed[0];
  if (other !== undefined) {
    throw notSendable(other);
  }
  // A gRPC API's streaming calls are not selectable, nor is anything in an API with no requests;
  // name the API's kind rather than "not found".
  const unsupported = [
    ...project.wsApis.map((api) => ({ name: api.name, kind: 'WebSocket' })),
    ...project.grpcApis.map((api) => ({ name: api.name, kind: 'gRPC' })),
  ].find((api) => ref === api.name || ref.startsWith(`${api.name}/`));
  if (unsupported !== undefined) {
    throw new OpsError(
      'unsupported-kind',
      `"${ref}" is in the ${unsupported.kind} API "${unsupported.name}"; send takes SOAP and REST requests`,
      { item: ref },
    );
  }
  // Nor is anything in a placeholder: the engine never read its request files. Say which and why.
  const placeholder = placeholderFor(project, ref);
  if (placeholder !== undefined) {
    const why = placeholder.reason === 'feature-disabled' ? 'that protocol is switched off' : 'it has no such protocol';
    throw new OpsError(
      'unsupported-kind',
      `"${ref}" is in "${placeholder.name ?? placeholder.slug}", a "${placeholder.kind}" container this build did not load: ${why}`,
      { item: ref, kind: placeholder.kind, reason: placeholder.reason },
    );
  }
  throw new OpsError('item-not-found', `No saved request matches "${ref}"; wirebench operations lists them`, {
    item: ref,
  });
}
