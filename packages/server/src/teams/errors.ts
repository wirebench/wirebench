/** Every `teams-*` problem (spec §3.2, §10), one function each so a code is spelled once. */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** §3.1: an outsider hears "not found", never "forbidden", so an id reveals nothing. */
export const teamNotFound = (): WirebenchError =>
  problem('teams-team-not-found', 'That team does not exist, or you are not on it.', 404);
export const workspaceNotFound = (): WirebenchError =>
  problem('teams-workspace-not-found', 'That workspace does not exist, or you have no access to it.', 404);
export const forbidden = (): WirebenchError => problem('teams-forbidden', 'Your role does not allow this.', 403);
export const nameTaken = (): WirebenchError =>
  problem('teams-name-taken', 'A team with this name already exists.', 409);
export const nameInvalid = (): WirebenchError =>
  problem('teams-name-invalid', 'Names are 1 to 80 characters, not counting spaces at either end.', 400);
export const notEmpty = (): WirebenchError =>
  problem('teams-not-empty', 'This team still owns workspaces. Remove them first.', 409);
export const userUnknown = (): WirebenchError =>
  problem('teams-user-unknown', 'No user has this email. Invite them instead.', 404);
export const alreadyMember = (): WirebenchError =>
  problem('teams-already-member', 'That user is already on this team.', 409);
export const memberNotFound = (): WirebenchError =>
  problem('teams-member-not-found', 'That user is not on this team.', 404);
export const lastAdmin = (): WirebenchError =>
  problem('teams-last-admin', 'A team needs at least one admin. Make someone else an admin first.', 400);
export const invitationNotFound = (): WirebenchError =>
  problem('teams-invitation-not-found', 'That invitation is not open on this team.', 404);
/** Identity's code, with the hint a team admin needs (§3.2). */
export const userExistsInvite = (): WirebenchError =>
  problem('identity-user-exists', 'A user with this email already exists. Add them as a member instead.', 409);
export const workspaceExists = (): WirebenchError =>
  problem('teams-workspace-exists', 'A workspace with this id already exists.', 409);
export const workspaceNameTaken = (): WirebenchError =>
  problem('teams-workspace-name-taken', 'This team already has a workspace with this name.', 409);
export const notAMember = (): WirebenchError =>
  problem('teams-not-a-member', "That user is not on this workspace's team.", 400);
