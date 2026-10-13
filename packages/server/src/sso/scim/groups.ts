/**
 * `/scim/v2/Groups` (saml-scim spec §3.5). Groups are stored with their members; a group does nothing to
 * a team until a server admin links it (§3.6). Members are SCIM user ids, which are Wirebench user ids.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { recordAudit, type Querier } from '../../context.js';
import { isUniqueViolation } from '../../db/errors.js';
import { newId } from '../../identity/tokens.js';
import type { SsoEnv } from '../env.js';
import { setGroupMembers } from '../provisioning.js';
import * as repo from '../repo.js';
import { GROUP_SCHEMA } from './discovery.js';
import { scimError } from './errors.js';
import { parseFilter } from './filter.js';
import { applyGroupPatch, memberIdsOf, type GroupState } from './group-patch.js';
import { PATCH_OP_SCHEMA, type PatchOperation } from './patch.js';
import { scimSource } from './plugin.js';
import { LIST_RESPONSE_SCHEMA } from './resources.js';
import { pageOf } from './users.js';

const NAME_INDEX = 'scim_groups_display_name_lower';
const uniqueness = () => scimError(409, 'A group with this displayName already exists.', 'uniqueness');
const notFound = () => scimError(404, 'No such group.');

function groupInput(body: unknown): { displayName: string; externalId: string | null; members: string[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw scimError(400, 'The body must be a SCIM group.', 'invalidSyntax');
  const record = body as Record<string, unknown>;
  const displayName = record['displayName'];
  if (typeof displayName !== 'string' || displayName.trim() === '')
    throw scimError(400, '"displayName" is required.', 'invalidValue');
  const externalId = record['externalId'];
  if (externalId !== undefined && externalId !== null && typeof externalId !== 'string')
    throw scimError(400, '"externalId" must be a string.', 'invalidValue');
  return {
    displayName: displayName.trim(),
    externalId: typeof externalId === 'string' && externalId.trim() !== '' ? externalId.trim() : null,
    members: [...new Set(memberIdsOf(record['members']))],
  };
}

function excludesMembers(request: FastifyRequest): boolean {
  const excluded = (request.query as Record<string, unknown>)['excludedAttributes'];
  return typeof excluded === 'string' && excluded.split(',').some((name) => name.trim().toLowerCase() === 'members');
}

export const groupRoutes =
  (env: SsoEnv) =>
  (scim: FastifyInstance): void => {
    const base = env.urls.scimBaseUrl;
    const db = env.ctx.db;

    async function resources(rows: readonly repo.ScimGroupRow[], withMembers: boolean, q: Querier = db) {
      const members = withMembers
        ? await repo.groupMembersWithEmail(
            q,
            rows.map((row) => row.id),
          )
        : undefined;
      return rows.map((row) => ({
        schemas: [GROUP_SCHEMA],
        id: row.id,
        ...(row.externalId !== null ? { externalId: row.externalId } : {}),
        displayName: row.displayName,
        ...(members !== undefined
          ? {
              members: members.get(row.id)!.map((member) => ({
                value: member.id,
                display: member.email,
                $ref: `${base}/Users/${member.id}`,
              })),
            }
          : {}),
        meta: {
          resourceType: 'Group',
          created: row.createdAt,
          lastModified: row.updatedAt,
          location: `${base}/Groups/${row.id}`,
        },
      }));
    }

    async function assertUsers(tx: Querier, ids: readonly string[]): Promise<void> {
      const unknown = await repo.unknownUserIds(tx, ids);
      if (unknown.length > 0) throw scimError(400, `No user with id ${unknown[0]!}.`, 'invalidValue');
    }

    /** Moves group `id` to `compute(current)`: its name, external id and members, with one audit event. */
    async function update(request: FastifyRequest, id: string, compute: (state: GroupState) => GroupState) {
      const source = scimSource(request);
      const now = env.now();
      const row = await db
        .transaction(async (tx: Querier) => {
          const current = await repo.scimGroupById(tx, id);
          if (current === undefined) throw notFound();
          const members = new Set(await repo.groupMemberIds(tx, id));
          const next = compute({ displayName: current.displayName, externalId: current.externalId, members });
          const added = [...next.members].filter((member) => !members.has(member));
          const removed = [...members].filter((member) => !next.members.has(member));
          await assertUsers(tx, added);
          const fields: string[] = [];
          if (next.displayName !== current.displayName) fields.push('displayName');
          if (next.externalId !== current.externalId) fields.push('externalId');
          const delta = await setGroupMembers(tx, id, added, removed);
          if (fields.length > 0 || delta.added.length > 0 || delta.removed.length > 0) {
            await repo.updateScimGroup(tx, id, { displayName: next.displayName, externalId: next.externalId }, now);
            await recordAudit(env.ctx.hooks, tx, {
              ...source,
              action: 'scim.group_updated',
              target: { kind: 'scim-group', id },
              ...(current.teamId !== null ? { teamId: current.teamId } : {}),
              details: {
                displayName: next.displayName,
                fields,
                membersAdded: delta.added.length,
                membersRemoved: delta.removed.length,
              },
            });
          }
          return (await repo.scimGroupById(tx, id))!;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, NAME_INDEX)) throw uniqueness();
          throw error;
        });
      return (await resources([row], true))[0];
    }

    scim.get('/Groups', async (request) => {
      const query = request.query as Record<string, unknown>;
      const filter = parseFilter(typeof query['filter'] === 'string' ? query['filter'] : undefined, [
        'displayName',
        'externalId',
      ]);
      const { startIndex, count } = pageOf(query);
      const page = await repo.listScimGroupPage(db, filter as repo.ScimGroupFilter | undefined, startIndex - 1, count);
      return {
        schemas: [LIST_RESPONSE_SCHEMA],
        totalResults: page.total,
        startIndex,
        itemsPerPage: page.groups.length,
        Resources: await resources(page.groups, !excludesMembers(request)),
      };
    });

    scim.get('/Groups/:id', async (request) => {
      const row = await repo.scimGroupById(db, (request.params as { id: string }).id);
      if (row === undefined) throw notFound();
      return (await resources([row], !excludesMembers(request)))[0];
    });

    scim.post('/Groups', async (request, reply) => {
      const input = groupInput(request.body);
      const source = scimSource(request);
      const now = env.now();
      const row = await db
        .transaction(async (tx: Querier) => {
          await assertUsers(tx, input.members);
          const created = await repo.insertScimGroup(tx, {
            id: newId(),
            displayName: input.displayName,
            externalId: input.externalId,
            at: now,
          });
          const delta = await setGroupMembers(tx, created.id, input.members, []);
          await recordAudit(env.ctx.hooks, tx, {
            ...source,
            action: 'scim.group_created',
            target: { kind: 'scim-group', id: created.id },
            details: { displayName: created.displayName, membersAdded: delta.added.length },
          });
          return created;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error, NAME_INDEX)) throw uniqueness();
          throw error;
        });
      return reply
        .code(201)
        .header('location', `${base}/Groups/${row.id}`)
        .send((await resources([row], true))[0]);
    });

    scim.put('/Groups/:id', async (request) => {
      const input = groupInput(request.body);
      return update(request, (request.params as { id: string }).id, () => ({
        displayName: input.displayName,
        externalId: input.externalId,
        members: new Set(input.members),
      }));
    });

    scim.patch('/Groups/:id', async (request) => {
      const record = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<
        string,
        unknown
      >;
      const schemas = record['schemas'];
      const operations = record['Operations'];
      if (!Array.isArray(schemas) || !schemas.includes(PATCH_OP_SCHEMA) || !Array.isArray(operations))
        throw scimError(400, 'The body must be a PatchOp with Operations.', 'invalidSyntax');
      const result = await update(request, (request.params as { id: string }).id, (state) =>
        applyGroupPatch(state, operations as PatchOperation[]),
      );
      return result;
    });

    scim.delete('/Groups/:id', async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const source = scimSource(request);
      await db.transaction(async (tx: Querier) => {
        const current = await repo.scimGroupById(tx, id);
        if (current === undefined) throw notFound();
        // Through the one membership path first, so a linked team loses what this group gave it (§3.6).
        await setGroupMembers(tx, id, [], await repo.groupMemberIds(tx, id));
        await repo.deleteScimGroup(tx, id);
        await recordAudit(env.ctx.hooks, tx, {
          ...source,
          action: 'scim.group_deleted',
          target: { kind: 'scim-group', id },
          ...(current.teamId !== null ? { teamId: current.teamId } : {}),
          details: { displayName: current.displayName },
        });
      });
      return reply.code(204).send();
    });
  };
