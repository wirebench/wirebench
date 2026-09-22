/**
 * Every secret a selection of requests will ask for, found before anything is sent, so a pipeline
 * can be told which variables to set (`wirebench secrets list`) and a run knows which names to
 * read. It walks the same sources `prepareSend` resolves: effective auth, the request's keystore,
 * and the WS-Security configurations it selects, with the keystores those lead to.
 */
import { resolveScopes } from '../project/environments.js';
import { toKeystoreDef } from '../project/keystores.js';
import { secretNamesIn } from '../project/properties.js';
import type { PropertyScopes } from '../project/properties.js';
import type { Project } from '../project/model.js';
import { toWssIncomingConfig, toWssOutgoingConfig } from '../project/wss-configs.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import type { WssIncomingConfig, WssOutgoingConfig } from '../wss/model.js';
import { restEffectiveAuth, soapEffectiveAuth } from './effective-auth.js';
import type { SelectedRequest } from './select.js';

/**
 * The `${secret:name}` names anywhere in `value`'s strings — a send input or a saved request —
 * following property values through `scopes`, in first-use order. Binary data is skipped.
 */
export function secretNamesInValue(value: unknown, scopes?: PropertyScopes): string[] {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      if (current.includes('${')) {
        for (const name of secretNamesIn(current, scopes)) {
          found.add(name);
        }
      }
    } else if (Array.isArray(current)) {
      current.forEach(visit);
    } else if (current !== null && typeof current === 'object' && !ArrayBuffer.isView(current)) {
      Object.values(current).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}

/** One secret a run needs, and which requests need it. */
export interface LocatedSecretNeed extends SecretNeed {
  /** Display paths of the requests that need it. */
  readonly usedBy: readonly string[];
}

const present = (id: string | undefined): id is string => id !== undefined && id.length > 0;

/** A keystore's password, when the registry entry has one; an unreadable entry needs nothing here. */
function keystoreNeeds(project: Project, keystoreId: string | undefined): SecretNeed[] {
  if (!present(keystoreId)) {
    return [];
  }
  const ref = project.wss.keystores.find((candidate) => candidate.id === keystoreId);
  if (ref === undefined) {
    return [];
  }
  try {
    const def = toKeystoreDef(ref);
    return present(def.passwordSecretRef)
      ? [
          {
            ref: def.passwordSecretRef,
            ...(def.passwordEnv !== undefined ? { envName: def.passwordEnv } : {}),
            purpose: `keystore password for "${def.name}"`,
          },
        ]
      : [];
  } catch {
    // `prepareSend` refuses such a request with its own error; it needs no secret before then.
    return [];
  }
}

/** Parses a WS-Security configuration by id; missing or unreadable is prepare's error, not a need. */
function findConfig<T>(
  refs: Project['wss']['outgoing'],
  id: string | undefined,
  convert: (ref: (typeof refs)[number]) => T,
): T | undefined {
  if (!present(id)) {
    return undefined;
  }
  const ref = refs.find((candidate) => candidate.id === id);
  if (ref === undefined) {
    return undefined;
  }
  try {
    return convert(ref);
  } catch {
    return undefined;
  }
}

/** WS-Security passwords carry no `…Env` name: they resolve through their ref-derived variable. */
function outgoingNeeds(project: Project, config: WssOutgoingConfig): SecretNeed[] {
  const needs: SecretNeed[] = [];
  for (const entry of config.entries) {
    if (entry.kind === 'username-token') {
      const ref = entry.passwordRef ?? config.defaultPasswordRef;
      if (entry.passwordType !== 'none' && present(ref)) {
        needs.push({ ref, purpose: `WS-Security password for "${entry.username}"` });
      }
    } else if (entry.kind === 'signature') {
      needs.push(...keystoreNeeds(project, entry.keystoreRef));
      if (present(entry.keyPasswordRef)) {
        needs.push({ ref: entry.keyPasswordRef, purpose: `WS-Security signing key password ("${config.name}")` });
      }
    } else if (entry.kind === 'encryption') {
      needs.push(...keystoreNeeds(project, entry.keystoreRef));
    }
  }
  return needs;
}

function incomingNeeds(project: Project, config: WssIncomingConfig): SecretNeed[] {
  return [
    ...keystoreNeeds(project, config.decryptKeystoreRef),
    ...(present(config.decryptKeyPasswordRef)
      ? [{ ref: config.decryptKeyPasswordRef, purpose: `WS-Security decryption key password ("${config.name}")` }]
      : []),
    ...keystoreNeeds(project, config.signatureKeystoreRef),
  ];
}

function tokenNeeds(selected: SelectedRequest, scopes: PropertyScopes): SecretNeed[] {
  return secretNamesInValue(selected.request, scopes).map((name) => ({
    ref: secretPseudoRef(name),
    envName: secretEnvName(name),
    purpose: `secret "${name}"`,
  }));
}

function needsOf(selected: SelectedRequest, project: Project, scopes: PropertyScopes): SecretNeed[] {
  if (selected.kind === 'rest') {
    return [
      ...tokenNeeds(selected, scopes),
      ...secretNeedsOfAuth(restEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
    ];
  }
  const { request } = selected;
  const outgoing = findConfig(project.wss.outgoing, request.wssOutgoingRef, toWssOutgoingConfig);
  const incoming = findConfig(project.wss.incoming, request.wssIncomingRef, toWssIncomingConfig);
  return [
    ...tokenNeeds(selected, scopes),
    ...secretNeedsOfAuth(soapEffectiveAuth(selected)),
    ...keystoreNeeds(project, request.properties.sslKeystoreRef),
    ...(outgoing !== undefined ? outgoingNeeds(project, outgoing) : []),
    ...(incoming !== undefined ? incomingNeeds(project, incoming) : []),
  ];
}

/**
 * The secrets `selected` needs, one entry per ref in first-use order, each with every request
 * that uses it. The first declaration of a ref supplies its name and purpose.
 */
export function secretNeedsOf(selected: readonly SelectedRequest[], project: Project): LocatedSecretNeed[] {
  const byRef = new Map<string, { need: SecretNeed; usedBy: string[] }>();
  // Project properties only: a token a property holds counts, whichever environment a run picks.
  const scopes = resolveScopes(project, undefined, {}, {});
  for (const item of selected) {
    for (const need of needsOf(item, project, scopes)) {
      const known = byRef.get(need.ref);
      if (known === undefined) {
        byRef.set(need.ref, { need, usedBy: [item.path] });
      } else {
        if (!known.usedBy.includes(item.path)) {
          known.usedBy.push(item.path);
        }
        if (known.need.envName === undefined && need.envName !== undefined) {
          known.need = { ...known.need, envName: need.envName };
        }
      }
    }
  }
  return [...byRef.values()].map(({ need, usedBy }) => ({ ...need, usedBy }));
}
