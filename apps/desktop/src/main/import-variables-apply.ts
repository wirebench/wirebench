// apps/desktop/src/main/import-variables-apply.ts
/**
 * Applies an importer's variable plan (engine `ImportedVariables`, spec §3.5): workspace
 * environments under a free name; Globals, workspace and project properties without touching an
 * existing name; secret values into the secret store behind a fresh `${secret:ref}`. Every
 * secret this call wrote is deleted again if any save fails, so a failed import leaves nothing
 * behind. The active environment is never changed.
 */
import type { ImportedVariable, ImportedVariables, ImportedVariableSet } from '@wirebench/engine';
import { uniqueName } from '@wirebench/engine';

export interface VariablesApplyPorts {
  readonly workspace: {
    environmentNames(): readonly string[];
    addEnvironment(name: string, properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
    propertyNames(): readonly string[];
    mergeProperties(properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
  };
  readonly globals: {
    get(): { readonly properties: Readonly<Record<string, string>>; readonly disabled: readonly string[] };
    merge(properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
  };
  readonly project?: {
    propertyNames(): readonly string[];
    merge(properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
  };
  readonly secrets: {
    set(value: string, opts: { label: string }): Promise<string>;
    delete(ref: string): Promise<boolean>;
  };
}
export interface MergeOutcome {
  readonly added: number;
  readonly skipped: readonly string[];
}
export interface VariablesApplyResult {
  readonly environments: readonly {
    readonly name: string;
    readonly renamedFrom?: string;
    readonly variables: number;
  }[];
  readonly globals?: MergeOutcome;
  readonly workspaceProperties?: MergeOutcome;
  readonly projectProperties?: MergeOutcome;
  readonly secretsStored: number;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

export async function applyImportedVariables(
  plan: ImportedVariables,
  ports: VariablesApplyPorts,
): Promise<VariablesApplyResult> {
  const written: string[] = [];
  const warnings: string[] = [...plan.report.warnings];
  const notes: string[] = [...plan.report.notes];

  const valueOf = async (owner: string, v: ImportedVariable): Promise<string> => {
    if (!v.secret) return v.value;
    if (v.secretValue === undefined || v.secretValue === '') {
      warnings.push(`${owner}: the secret "${v.name}" had no value in the file; set it in Environments.`);
      return '';
    }
    const ref = await ports.secrets.set(v.secretValue, { label: `${owner}/${v.name}` });
    written.push(ref);
    return `\${secret:${ref}}`;
  };

  const resolveSet = async (owner: string, variables: readonly ImportedVariable[]) => {
    const properties: Record<string, string> = {};
    const disabled: string[] = [];
    for (const v of variables) {
      properties[v.name] = await valueOf(owner, v);
      if (!v.enabled) disabled.push(v.name);
    }
    return { properties, disabled };
  };

  const mergeInto = async (
    owner: string,
    set: ImportedVariableSet | undefined,
    existing: readonly string[],
    merge: (properties: Record<string, string>, disabled: readonly string[]) => Promise<void>,
  ): Promise<MergeOutcome | undefined> => {
    if (set === undefined) return undefined;
    const taken = new Set(existing);
    const fresh = set.variables.filter((v) => !taken.has(v.name));
    const skipped = set.variables.filter((v) => taken.has(v.name)).map((v) => v.name);
    for (const name of skipped) notes.push(`${owner}: "${name}" already exists and kept its current value.`);
    if (fresh.length > 0) {
      const { properties, disabled } = await resolveSet(owner, fresh);
      await merge(properties, disabled);
    }
    return { added: fresh.length, skipped };
  };

  try {
    const environments: { name: string; renamedFrom?: string; variables: number }[] = [];
    for (const env of plan.environments) {
      const name = uniqueName(env.name, ports.workspace.environmentNames());
      if (name !== env.name) {
        notes.push(`An environment named "${env.name}" already exists, so this one was imported as "${name}".`);
      }
      const { properties, disabled } = await resolveSet(name, env.variables);
      await ports.workspace.addEnvironment(name, properties, disabled);
      environments.push({
        name,
        ...(name !== env.name ? { renamedFrom: env.name } : {}),
        variables: env.variables.length,
      });
    }

    const globals = await mergeInto('Globals', plan.globals, Object.keys(ports.globals.get().properties), (p, d) =>
      ports.globals.merge(p, d),
    );
    const workspaceProperties = await mergeInto(
      'Workspace properties',
      plan.workspaceProperties,
      ports.workspace.propertyNames(),
      (p, d) => ports.workspace.mergeProperties(p, d),
    );
    const project = ports.project;
    const projectProperties =
      project === undefined
        ? undefined
        : await mergeInto('Project properties', plan.projectProperties, project.propertyNames(), (p, d) =>
            project.merge(p, d),
          );
    if (project === undefined && plan.projectProperties !== undefined && plan.projectProperties.variables.length > 0) {
      warnings.push('Project properties were not imported because no project was chosen.');
    }

    return {
      environments,
      ...(globals !== undefined ? { globals } : {}),
      ...(workspaceProperties !== undefined ? { workspaceProperties } : {}),
      ...(projectProperties !== undefined ? { projectProperties } : {}),
      secretsStored: written.length,
      warnings,
      notes,
    };
  } catch (error) {
    await Promise.all(written.map((ref) => ports.secrets.delete(ref).catch(() => false)));
    throw error;
  }
}
