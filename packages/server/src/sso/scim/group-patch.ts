/**
 * SCIM `PatchOp` on a group (RFC 7644 §3.5.2, saml-scim spec §3.5): `members` add, remove and replace,
 * including the `members[value eq "…"]` path form one IdP sends and the value list the other sends with a
 * `remove`, and `displayName` / `externalId` replace. Applied to a plain state; the route works out what
 * changed and writes it.
 */
import { scimError } from './errors.js';
import type { PatchOperation } from './patch.js';

export interface GroupState {
  readonly displayName: string;
  readonly externalId: string | null;
  readonly members: ReadonlySet<string>;
}

const MEMBER_FILTER = /^members\[value eq "((?:[^"\\]|\\.)*)"\]$/i;

/** The `value`s of a members list, as a SCIM body carries it. */
export function memberIdsOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((member) => {
    const id = typeof member === 'object' && member !== null ? (member as Record<string, unknown>)['value'] : undefined;
    if (typeof id !== 'string' || id === '') throw scimError(400, 'Each member needs a "value".', 'invalidValue');
    return id;
  });
}

const text = (value: unknown, attribute: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw scimError(400, `"${attribute}" must be a non-empty string.`, 'invalidValue');
  return value.trim();
};

export function applyGroupPatch(state: GroupState, operations: readonly PatchOperation[]): GroupState {
  let { displayName, externalId } = state;
  const members = new Set(state.members);
  const setAttribute = (attribute: string, value: unknown, op: string): void => {
    switch (attribute.toLowerCase()) {
      case 'displayname':
        if (op === 'remove') throw scimError(400, '"displayName" is required.', 'mutability');
        displayName = text(value, 'displayName');
        return;
      case 'externalid':
        externalId = op === 'remove' ? null : text(value, 'externalId');
        return;
      case 'members': {
        const ids = memberIdsOf(value);
        if (op === 'replace') members.clear();
        if (op === 'remove') {
          // No value removes every member (RFC 7644 §3.5.2.2).
          if (value === undefined || value === null) members.clear();
          for (const id of ids) members.delete(id);
        } else for (const id of ids) members.add(id);
        return;
      }
      case 'id':
      case 'schemas':
      case 'meta':
        return; // Read-only; some IdPs echo them back.
      default:
        throw scimError(400, `"${attribute}" is not an attribute of a group.`, 'invalidPath');
    }
  };
  for (const operation of operations) {
    const op = typeof operation.op === 'string' ? operation.op.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove')
      throw scimError(400, `"${String(operation.op)}" is not a PATCH operation.`, 'invalidSyntax');
    const path = operation.path?.trim() ?? '';
    const filtered = MEMBER_FILTER.exec(path);
    if (filtered !== null) {
      if (op !== 'remove') throw scimError(400, 'Only a remove may filter members.', 'invalidPath');
      members.delete(filtered[1]!.replace(/\\(.)/g, '$1'));
      continue;
    }
    if (path !== '') {
      setAttribute(path, operation.value, op);
      continue;
    }
    if (op === 'remove') throw scimError(400, 'A remove needs a path.', 'noTarget');
    if (typeof operation.value !== 'object' || operation.value === null || Array.isArray(operation.value))
      throw scimError(400, 'A PATCH without a path needs an object value.', 'invalidValue');
    for (const [attribute, value] of Object.entries(operation.value)) setAttribute(attribute, value, op);
  }
  return { displayName, externalId, members };
}
