/**
 * The format-neutral variable plan every environment-bearing importer produces (spec §3.1). The
 * engine never stores a secret: a secret's value travels in `secretValue` to the desktop main
 * process, which puts it in the secret store and writes only a `${secret:…}` reference.
 */
import type { ImportReport, ReportBuilder } from './report.js';

export interface ImportedVariable {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly secret: boolean;
  readonly secretValue?: string;
}

export interface ImportedVariableSet {
  readonly name: string;
  readonly variables: readonly ImportedVariable[];
}

export interface ImportedVariables {
  readonly environments: readonly ImportedVariableSet[];
  readonly globals?: ImportedVariableSet;
  readonly workspaceProperties?: ImportedVariableSet;
  readonly projectProperties?: ImportedVariableSet;
  readonly report: ImportReport;
}

export const CREDENTIAL_NAME = /token|password|secret|apikey|api_key/i;

export class VariableSetBuilder {
  private readonly variables: ImportedVariable[] = [];
  private readonly names = new Set<string>();

  constructor(
    private readonly name: string,
    private readonly report: ReportBuilder,
  ) {}

  add(variable: ImportedVariable, where?: string): void {
    if (this.names.has(variable.name)) {
      const place = where === undefined ? '' : ` (${where})`;
      this.report.note(`${this.name}: "${variable.name}" is defined more than once${place}; the first value was kept.`);
      return;
    }
    this.names.add(variable.name);
    this.variables.push(variable);
  }

  get size(): number {
    return this.variables.length;
  }

  build(): ImportedVariableSet {
    return { name: this.name, variables: [...this.variables] };
  }
}

export function credentialLookingNames(sets: readonly ImportedVariableSet[]): string[] {
  const names = new Set<string>();
  for (const set of sets) {
    for (const v of set.variables) if (!v.secret && CREDENTIAL_NAME.test(v.name)) names.add(v.name);
  }
  return [...names];
}

/** The one warning spec §3.4 asks for, or nothing. */
export function warnCredentialLookingNames(report: ReportBuilder, sets: readonly ImportedVariableSet[]): void {
  const names = credentialLookingNames(sets);
  if (names.length > 0) {
    report.warn(
      `These variables look like credentials but are not marked secret, so their values were imported as plain text: ${names.join(', ')}. Mark them Secret in Environments.`,
    );
  }
}
