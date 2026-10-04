/**
 * The `.http` client's environment files: `http-client.env.json` (public) and
 * `http-client.private.env.json` (private), each `{ "$shared": {…}, "<env>": {…} }`. Pure, so
 * nothing here may reach `node:` or an id generator.
 */

import { HttpFileError } from '../../errors.js';
import { isCredentialName } from '../../import/credentials.js';
import { ReportBuilder } from '../../import/report.js';
import { rewriteMustache } from '../../import/templates.js';
import type { ImportedVariable, ImportedVariables } from '../../import/variables.js';
import { VariableSetBuilder, warnCredentialLookingNames } from '../../import/variables.js';

export const HTTP_ENV_FILE = 'http-client.env.json';
export const HTTP_PRIVATE_ENV_FILE = 'http-client.private.env.json';

const SHARED = '$shared';

type Scalar = string | number | boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function parseRoot(text: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new HttpFileError('http-env-malformed', `${file} is not valid JSON`, { cause });
  }
  if (!isRecord(parsed)) {
    throw new HttpFileError('http-env-not-environments', `${file} is not an object of environments`);
  }
  return parsed;
}

function secretOf(name: string, value: Scalar): ImportedVariable {
  return { name, value: '', enabled: true, secret: true, secretValue: String(value) };
}

/** A public value: a credential-named literal becomes a secret (with a note), anything else stays plain. */
function publicVariable(where: string, key: string, value: Scalar, report: ReportBuilder): ImportedVariable {
  const text = String(value);
  if (isCredentialName(key) && text.length > 0 && !text.includes('{{')) {
    report.note(
      `${where}: "${key}" looks like a credential, so its public value was imported as a secret rather than plain text.`,
    );
    return secretOf(key, value);
  }
  return { name: key, value: rewriteMustache(text), enabled: true, secret: false };
}

/**
 * The environments of a public and a private `.http` environment file. A private value is always
 * a secret and wins over a public one of the same name; a credential-named public literal is
 * imported as a secret too, so it never reaches a workspace file. `$shared` goes to project
 * properties, or to workspace properties when the files are imported on their own.
 */
export function parseHttpEnvFiles(
  publicText: string | undefined,
  privateText: string | undefined,
  sharedTarget: 'project' | 'workspace-properties',
): ImportedVariables {
  const report = new ReportBuilder();
  const publicRoot = publicText === undefined ? {} : parseRoot(publicText, HTTP_ENV_FILE);
  const privateRoot = privateText === undefined ? {} : parseRoot(privateText, HTTP_PRIVATE_ENV_FILE);

  const names: string[] = [];
  for (const root of [publicRoot, privateRoot]) {
    for (const key of Object.keys(root)) if (key !== SHARED && !names.includes(key)) names.push(key);
  }

  const environments = names.map((env) => {
    const builder = new VariableSetBuilder(env, report);
    const privateValues = privateRoot[env];
    const privateNames = new Set<string>();
    if (isRecord(privateValues)) {
      for (const [key, value] of Object.entries(privateValues)) {
        if (!isScalar(value)) {
          report.note(`${env}: "${key}" is a settings object, not a variable, and was skipped.`);
          continue;
        }
        privateNames.add(key);
        builder.add(secretOf(key, value));
      }
    }
    const publicValues = publicRoot[env];
    if (isRecord(publicValues)) {
      for (const [key, value] of Object.entries(publicValues)) {
        if (!isScalar(value)) {
          report.note(`${env}: "${key}" is a settings object, not a variable, and was skipped.`);
          continue;
        }
        if (privateNames.has(key)) continue;
        builder.add(publicVariable(env, key, value, report));
      }
    }
    return builder.build();
  });

  const result: {
    -readonly [K in keyof ImportedVariables]: ImportedVariables[K];
  } = { environments, report: report.build() };

  const shared = [publicRoot[SHARED], privateRoot[SHARED]];
  if (shared.some(isRecord)) {
    const label = sharedTarget === 'project' ? 'Project properties' : 'Workspace properties';
    const builder = new VariableSetBuilder(label, report);
    const privateShared = isRecord(shared[1]) ? shared[1] : {};
    const privateNames = new Set<string>();
    for (const [key, value] of Object.entries(privateShared)) {
      if (!isScalar(value)) {
        report.note(`${SHARED}: "${key}" is a settings object, not a variable, and was skipped.`);
        continue;
      }
      privateNames.add(key);
      builder.add(secretOf(key, value));
    }
    if (isRecord(shared[0])) {
      for (const [key, value] of Object.entries(shared[0])) {
        if (!isScalar(value)) {
          report.note(`${SHARED}: "${key}" is a settings object, not a variable, and was skipped.`);
        } else if (!privateNames.has(key)) {
          builder.add(publicVariable(SHARED, key, value, report));
        }
      }
    }
    const set = builder.build();
    if (sharedTarget === 'project') result.projectProperties = set;
    else result.workspaceProperties = set;
  }

  warnCredentialLookingNames(report, [
    ...environments,
    ...(result.projectProperties ? [result.projectProperties] : []),
    ...(result.workspaceProperties ? [result.workspaceProperties] : []),
  ]);
  result.report = report.build();
  return result;
}
