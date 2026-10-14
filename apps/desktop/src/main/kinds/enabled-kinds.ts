/**
 * The developer switch for the desktop's kinds (kind modules spec §7.3): `WIREBENCH_KINDS`
 * (`grpc=off,websocket=off`), read at start-up like `WIREBENCH_AREAS`. Phase 4 replaces it with
 * Settings and team policy.
 */
import {
  BUILTIN_PROTOCOLS,
  createBuiltinRegistry,
  nodeFs,
  type FsLike,
  type ProtocolRegistry,
} from '@wirebench/engine';
import type { UnsupportedContainerWire } from '../../shared/wire-base.js';
import { KINDS, type KindId } from '../../shared/kinds/kind-module.js';
import { parseAreaSwitches } from '../areas.js';

/** The kinds `WIREBENCH_KINDS` leaves on, in the kinds' order. Anything not `<kind>=on|off` is ignored. */
export function enabledKindsFromEnv(env: NodeJS.ProcessEnv = process.env): readonly KindId[] {
  const switches = parseAreaSwitches(env['WIREBENCH_KINDS']);
  return KINDS.filter((kind) => switches[kind.kind] !== false).map((kind) => kind.kind);
}

/**
 * The engine registry for this run: the built-in protocols with the kinds that are off switched off,
 * so a project's containers of those kinds load as placeholders and are saved untouched.
 */
export function kindRegistry(enabled: readonly KindId[]): ProtocolRegistry {
  return createBuiltinRegistry(
    Object.fromEntries(KINDS.map((kind) => [kind.feature.id, enabled.includes(kind.kind)] as const)),
  );
}

/** What each kind keeps for the whole project rather than in a container, as the explorer names it. */
const PROJECT_FILES_NAME: Partial<Record<KindId, string>> = {
  rest: 'Webhooks',
  soap: 'WS-Security configurations',
};

/**
 * The project-level files (REST's `webhooks/`, SOAP's `wss/`) of each kind that is off, as placeholders:
 * the engine neither loads nor saves them, so they stay on disk as they are, and the explorer shows
 * one row per folder saying why rather than leaving them out unseen.
 */
export async function switchedOffProjectFiles(
  dir: string,
  enabled: readonly KindId[],
  fs: FsLike = nodeFs,
): Promise<UnsupportedContainerWire[]> {
  const placeholders: UnsupportedContainerWire[] = [];
  for (const module of BUILTIN_PROTOCOLS) {
    const kind = KINDS.find((candidate) => candidate.kind === module.kind)?.kind;
    if (kind === undefined || enabled.includes(kind) || module.projectFiles === undefined) continue;
    const files = await module.projectFiles.managed(fs, dir);
    const folders = [...new Set(files.map((file) => file.split('/')[0] ?? file))];
    const name = PROJECT_FILES_NAME[kind];
    for (const folder of folders) {
      placeholders.push({
        dir: folder,
        slug: folder,
        kind,
        reason: 'feature-disabled',
        ...(name !== undefined ? { name } : {}),
      });
    }
  }
  return placeholders;
}
