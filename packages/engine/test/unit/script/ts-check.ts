/**
 * Test helper: type-checks a script against declarations with the TypeScript compiler, in memory.
 * The engine's own checker (Task 6) is what the app and CLI use; this proves the generated types
 * compile and narrow as intended.
 */
import ts from 'typescript';

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
  types: [],
  skipLibCheck: false,
};

/** The diagnostics for `script` checked against `declarations`, as `line: message` strings. */
export function typeErrors(declarations: string, script: string): string[] {
  const files = new Map([
    ['/types.d.ts', declarations],
    ['/script.ts', script],
  ]);
  const host = ts.createCompilerHost(OPTIONS);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version) => {
    const text = files.get(name);
    return text !== undefined ? ts.createSourceFile(name, text, version) : getSourceFile(name, version);
  };
  host.fileExists = (name) => files.has(name) || ts.sys.fileExists(name);
  host.readFile = (name) => files.get(name) ?? ts.sys.readFile(name);
  const program = ts.createProgram(['/types.d.ts', '/script.ts'], OPTIONS, host);
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where =
      d.file !== undefined && d.start !== undefined
        ? `${d.file.fileName}:${String(d.file.getLineAndCharacterOfPosition(d.start).line + 1)}: `
        : '';
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}
