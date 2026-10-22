/** What an import did not bring across (warnings) and what it did on the user's behalf (notes). */
export interface ImportReport {
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

export class ReportBuilder {
  private readonly warnings: string[] = [];
  private readonly notes: string[] = [];
  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
  note(message: string): void {
    if (!this.notes.includes(message)) this.notes.push(message);
  }
  build(): ImportReport {
    return { warnings: [...this.warnings], notes: [...this.notes] };
  }
}

/** `name`, or `name 2`, `name 3`, … — the first not in `taken`, compared without case. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const lowered = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lowered.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!lowered.has(candidate.toLowerCase())) return candidate;
  }
}

export function formatImportReport(report: ImportReport): string {
  return [...report.warnings.map((w) => `Warning: ${w}`), ...report.notes.map((n) => `Note: ${n}`)].join('\n');
}
