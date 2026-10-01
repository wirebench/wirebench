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

function sendable(item: SelectedRequest): SendableItem {
  if (item.kind === 'grpc') {
    throw new OpsError('unsupported-kind', `"${item.path}" is a gRPC request; send takes SOAP and REST requests`, {
      item: item.path,
    });
  }
  return item;
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

/** @throws OpsError `item-not-found`, `item-ambiguous`, `unsupported-kind` */
export function resolveItem(project: Project, ref: string): SendableItem {
  const { selected } = selectRequests(project, [ref]);
  const exact = selected.filter((item) => item.path === ref);
  if (exact.length === 1 && exact[0] !== undefined) {
    return sendable(exact[0]);
  }
  if (selected.length === 1 && selected[0] !== undefined) {
    return sendable(selected[0]);
  }
  if (selected.length > 1) {
    throw ambiguous(ref, selected);
  }
  const named = selectRequests(project, []).selected.filter((item) => item.request.name === ref);
  if (named.length === 1 && named[0] !== undefined) {
    return sendable(named[0]);
  }
  if (named.length > 1) {
    throw ambiguous(ref, named);
  }
  // WebSocket APIs and streaming gRPC calls are not selectable at all; name them rather than "not found".
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
