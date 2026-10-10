/**
 * Where the secret scanner looks: every stored value in a project that is sent or expanded, as a
 * {@link ScanTarget} carrying the exact {@link SecretLocation} a later rewrite (`applySecretMoves`)
 * needs to find that text again. Core reads the project's and its environments' properties; each
 * protocol's secrets facet reads its own.
 *
 * Pure module: no I/O.
 */
import type { Project } from '../../project/model.js';
import type { ProtocolRegistry } from '../../protocol/registry.js';
import { defaultRegistry } from '../../protocols.js';
import { SEP } from './support.js';
import type { ScanTarget } from './support.js';

export type { ScanTarget, SecretFinding, SecretLocation } from './support.js';

/** Every scannable stored text in `project`: its properties, then each enabled module's, in registry order. */
export function* scanTargets(project: Project, registry: ProtocolRegistry = defaultRegistry()): Generator<ScanTarget> {
  for (const [name, value] of Object.entries(project.properties)) {
    if (value === '') continue;
    yield {
      location: { kind: 'project-property', name },
      label: `${project.name}${SEP}property ${name}`,
      text: value,
      context: { fieldName: name, nameKind: 'property' },
    };
  }
  for (const env of project.environments) {
    for (const [name, value] of Object.entries(env.properties)) {
      if (value === '') continue;
      yield {
        location: { kind: 'env-property', environmentId: env.id, name },
        label: `Environment ${env.name}${SEP}property ${name}`,
        text: value,
        context: { fieldName: name, nameKind: 'property' },
      };
    }
  }
  for (const module of registry.modules) {
    if (module.secrets !== undefined) yield* module.secrets.scanTargets(project);
  }
}
