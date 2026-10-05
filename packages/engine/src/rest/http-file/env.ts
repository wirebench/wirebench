/**
 * The `.http` client's environment files: `http-client.env.json` (public) and
 * `http-client.private.env.json` (private), each `{ "$shared": {…}, "<env>": {…} }`. Pure, so
 * nothing here may reach `node:` or an id generator.
 */

import { HttpFileError } from '../../errors.js';
import { isCredentialName } from '../../import/credentials.js';
import { ReportBuilder } from '../../import/report.js';
import type { ImportedVariable, ImportedVariables } from '../../import/variables.js';
import { VariableSetBuilder, warnCredentialLookingNames } from '../../import/variables.js';
import type { HttpRewriteContext } from './values.js';
import {
  looksLikeBareAuthority,
  newRewriteContext,
  referencesOnly,
  rewriteHttpValue,
  stripUserinfo,
} from './values.js';

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

function secretOf(name: string, value: string): ImportedVariable {
  return { name, value: '', enabled: true, secret: true, secretValue: value };
}

/** A private value: always a secret, with its templates rewritten as a public value's are. */
function privateVariable(key: string, value: Scalar, ctx: HttpRewriteContext): ImportedVariable {
  return secretOf(key, rewriteHttpValue(String(value), ctx));
}

/**
 * A public value, with its templates rewritten. A credential-named value that is not made of
 * references alone becomes a secret (with a note); any other value loses literal user info from a
 * URL (with a warning), as a `.http` file's `@variables` do.
 */
function publicVariable(
  where: string,
  key: string,
  value: Scalar,
  ctx: HttpRewriteContext,
  report: ReportBuilder,
): ImportedVariable {
  const text = rewriteHttpValue(String(value), ctx);
  if (isCredentialName(key) && text !== '' && !referencesOnly(text)) {
    report.note(
      `${where}: "${key}" looks like a credential, so its public value was imported as a secret rather than plain text.`,
    );
    return secretOf(key, text);
  }
  const { url, stripped } = stripUserinfo(text, looksLikeBareAuthority(text));
  if (stripped) report.warn(`${where}: the credential in the URL of "${key}" was not imported.`);
  return { name: key, value: url, enabled: true, secret: false };
}

/**
 * The environments of a public and a private `.http` environment file. A private value is always
 * a secret and wins over a public one of the same name; a credential-named public value that is
 * not made of references alone is imported as a secret too, so it never reaches a workspace file,
 * and literal user info is cut from a public URL. Templates are rewritten as in the `.http` file. `$shared` goes to project
 * properties, or to workspace properties when the files are imported on their own.
 */
export function parseHttpEnvFiles(
  publicText: string | undefined,
  privateText: string | undefined,
  sharedTarget: 'project' | 'workspace-properties',
): ImportedVariables {
  const report = new ReportBuilder();
  const ctx = newRewriteContext();
  // A private value's chaining references are counted, never listed: the report reaches the renderer.
  const privateCtx = newRewriteContext();
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
        builder.add(privateVariable(key, value, privateCtx));
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
        builder.add(publicVariable(env, key, value, ctx, report));
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
      builder.add(privateVariable(key, value, privateCtx));
    }
    if (isRecord(shared[0])) {
      for (const [key, value] of Object.entries(shared[0])) {
        if (!isScalar(value)) {
          report.note(`${SHARED}: "${key}" is a settings object, not a variable, and was skipped.`);
        } else if (!privateNames.has(key)) {
          builder.add(publicVariable(SHARED, key, value, ctx, report));
        }
      }
    }
    const set = builder.build();
    if (sharedTarget === 'project') result.projectProperties = set;
    else result.workspaceProperties = set;
  }

  if (ctx.chained.size > 0) {
    report.warn(
      `These request-chaining references were kept as written and need a script or a property capture: ${[...ctx.chained].join(', ')}`,
    );
  }
  if (privateCtx.chained.size > 0) {
    report.warn(
      `${privateCtx.chained.size} request-chaining reference(s) in ${HTTP_PRIVATE_ENV_FILE} were kept as written and need a script or a property capture.`,
    );
  }
  const dynamic = new Set([...ctx.dynamic, ...privateCtx.dynamic]);
  if (dynamic.size > 0) {
    report.warn(`Dynamic variables are kept as written and not expanded: ${[...dynamic].sort().join(', ')}`);
  }
  warnCredentialLookingNames(report, [
    ...environments,
    ...(result.projectProperties ? [result.projectProperties] : []),
    ...(result.workspaceProperties ? [result.workspaceProperties] : []),
  ]);
  result.report = report.build();
  return result;
}
