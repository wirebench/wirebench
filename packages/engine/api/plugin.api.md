# `@wirebench/engine/plugin` API report

Written by `pnpm plugin-api:report`, checked by `pnpm check:plugin-api`. A change here needs a
`PLUGIN_API_VERSION` bump: minor to add, major to break.

PLUGIN_API_VERSION: 1.0.0

```ts
export declare const PLUGIN_API_VERSION = '1.0.0';
export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly api: 1;
  readonly main: string;
  readonly description?: string;
  readonly contributes: PluginContributes;
  readonly capabilities?: PluginCapabilities;
}
export interface PluginContributes {
  readonly importers?: readonly ImporterDeclaration[];
  readonly reporters?: readonly ReporterDeclaration[];
  readonly codeGenerators?: readonly CodeGeneratorDeclaration[];
}
export interface ImporterDeclaration {
  readonly id: string;
  readonly title: string;
  readonly extensions?: readonly string[];
}
export interface ReporterDeclaration {
  readonly id: string;
  readonly title: string;
  readonly extension: string;
}
export interface CodeGeneratorDeclaration {
  readonly id: string;
  readonly title: string;
  readonly language: string;
}
export interface PluginCapabilities {
  readonly network?: readonly string[];
}
export interface PluginModule {
  readonly importers?: Readonly<Record<string, Importer>>;
  readonly reporters?: Readonly<Record<string, Reporter>>;
  readonly codeGenerators?: Readonly<Record<string, CodeGenerator>>;
}
export interface PluginContext {
  log(message: string): void;
}
export interface Importer {
  detect(input: ImportInput): 'definite' | 'probable' | null;
  import(input: ImportInput, context: ImportContext): ImportResult | Promise<ImportResult>;
}
export interface ImportInput {
  readonly filename: string;
  readonly text: string;
}
export interface ImportContext extends PluginContext {
  readonly net?: PluginNet;
}
export interface PluginNet {
  fetch(request: NetRequest): Promise<NetResponse>;
}
export interface NetRequest {
  readonly method?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
export interface NetResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export interface ImportResult {
  readonly apis: readonly ImportedApi[];
  readonly variables?: readonly ImportedVariable[];
  readonly environments?: readonly ImportedEnvironment[];
  readonly report?: {
    readonly warnings?: readonly string[];
    readonly notes?: readonly string[];
  };
}
export interface ImportedApi {
  readonly name: string;
  readonly description?: string;
  readonly items: readonly ImportedItem[];
}
export type ImportedItem = ImportedFolder | ImportedRequest;
export interface ImportedFolder {
  readonly kind: 'folder';
  readonly name: string;
  readonly items: readonly ImportedItem[];
}
export interface ImportedRequest {
  readonly kind: 'request';
  readonly name: string;
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly NameValue[];
  readonly body?: ImportedBody;
  readonly description?: string;
}
export type ImportedBody =
  | {
      readonly kind: 'raw';
      readonly text: string;
      readonly contentType?: string;
    }
  | {
      readonly kind: 'form';
      readonly fields: readonly NameValue[];
    };
export interface NameValue {
  readonly name: string;
  readonly value: string;
}
export interface ImportedVariable extends NameValue {
  readonly secret?: boolean;
}
export interface ImportedEnvironment {
  readonly name: string;
  readonly variables: readonly ImportedVariable[];
}
export interface Reporter {
  render(report: RunReport, context: PluginContext): string;
}
export interface RunReport {
  readonly formatVersion: 1;
  readonly tool: {
    readonly name: string;
    readonly version: string;
  };
  readonly startedAt: string;
  readonly environment?: string;
  readonly summary: RunReportSummary;
  readonly requests: readonly RunReportRequest[];
}
export interface RunReportSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly durationMs: number;
}
export interface RunReportRequest {
  readonly path: string;
  readonly group: string;
  readonly name: string;
  readonly protocol: string;
  readonly outcome: 'passed' | 'failed' | 'errored' | 'skipped';
  readonly status?: number;
  readonly durationMs?: number;
  readonly unasserted: boolean;
  readonly assertions: readonly RunReportAssertion[];
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly sequence?: {
    readonly id: string;
    readonly name: string;
    readonly stepId: string;
  };
  readonly iteration?: {
    readonly index: number;
    readonly count: number;
    readonly row?: number;
  };
}
export interface RunReportAssertion {
  readonly type: string;
  readonly label: string;
  readonly outcome: 'passed' | 'failed' | 'errored';
  readonly expected?: string;
  readonly actual?: string;
  readonly message?: string;
}
export interface CodeGenerator {
  generate(request: CodeRequest, layout: Layout, context: PluginContext): GeneratedCode;
}
export type Text = readonly TextPart[];
export type TextPart =
  | {
      readonly text: string;
    }
  | {
      readonly env: string;
    };
export interface CodeRequest {
  readonly method: string;
  readonly url: Text;
  readonly headers: readonly {
    readonly name: string;
    readonly value: Text;
  }[];
  readonly body: CodeBody;
  readonly basic?: {
    readonly username: Text;
    readonly password: Text;
  };
  readonly insecure?: boolean;
  readonly followRedirects: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}
export type CodeBody =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'raw';
      readonly text: Text;
    }
  | {
      readonly kind: 'form';
      readonly fields: readonly {
        readonly name: string;
        readonly value: Text;
      }[];
    }
  | {
      readonly kind: 'multipart';
      readonly parts: readonly CodePart[];
    }
  | {
      readonly kind: 'binary';
      readonly path: string;
    };
export type CodePart =
  | {
      readonly kind: 'text';
      readonly name: string;
      readonly value: Text;
      readonly contentType?: string;
    }
  | {
      readonly kind: 'file';
      readonly name: string;
      readonly path: string;
      readonly contentType?: string;
    };
export interface Layout {
  readonly unit: string;
  readonly followRedirects: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
}
export interface GeneratedCode {
  readonly code: string;
  readonly notes: readonly string[];
}
```
