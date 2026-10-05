// @vitest-environment node
/**
 * The `import` scan every `.proto` reader follows imports with. It only finds targets, so what
 * matters is that it finds the real ones, skips those in comments and strings, and stays linear on
 * a hostile file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtoImportService } from '../src/main/proto-import.js';
import { protoImportsOf } from '../src/main/proto-imports-of.js';

function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe('protoImportsOf', () => {
  it('finds plain, public and weak imports, in order', () => {
    const text = [
      'syntax = "proto3";',
      'package pets.v1;',
      'import "shared/common.proto";',
      '  import public "a.proto" ;',
      "import weak 'b.proto';",
      'import\n"c.proto"\n;',
      'message Pet { string name = 1; }',
      'import "after-a-message.proto";',
    ].join('\n');
    expect(protoImportsOf(text)).toEqual([
      'shared/common.proto',
      'a.proto',
      'b.proto',
      'c.proto',
      'after-a-message.proto',
    ]);
  });

  it('skips imports in comments and in strings, and an import not at a statement start', () => {
    const text = [
      'syntax = "proto3";',
      '// import "line-comment.proto";',
      '/* import "block-comment.proto"; */',
      'option go_package = "x; import \\"in-a-string.proto\\";";',
      'message M { string import = 1; }',
      'import "real.proto";',
    ].join('\n');
    expect(protoImportsOf(text)).toEqual(['real.proto']);
  });

  it('reads past a byte-order mark at the start of the file', () => {
    expect(protoImportsOf('\uFEFFimport "first.proto";\nimport "second.proto";')).toEqual([
      'first.proto',
      'second.proto',
    ]);
  });

  it('leaves out an import with no target or no semicolon', () => {
    expect(protoImportsOf('import "";\nimport "no-semicolon.proto"\nmessage M {}')).toEqual([]);
  });

  it('is linear on hostile input', () => {
    // 256 KB: a quadratic scan takes seconds here, and a linear one stays well inside the bound even
    // under the coverage run's instrumentation.
    const n = 256 * 1024;
    for (const unit of ['import ', '\n', ' \n', 'import "', '"\\', '/*', '//', 'import "a";', '/', ';import public']) {
      const input = unit.repeat(Math.ceil(n / unit.length));
      expect(
        timed(() => protoImportsOf(input)),
        unit,
      ).toBeLessThan(200);
    }
  });
});

describe('a picked-files import', () => {
  it('does not read a file named only in a commented-out import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-proto-scan-'));
    try {
      writeFileSync(
        join(dir, 'a.proto'),
        'syntax = "proto3";\n// import "b.proto";\n/* import "b.proto"; */\nmessage A { string a = 1; }\n',
      );
      writeFileSync(join(dir, 'b.proto'), 'syntax = "proto3";\nmessage B { string b = 1; }\n');
      const run = await new ProtoImportService().run({ source: { kind: 'files', paths: [join(dir, 'a.proto')] } });
      expect(run.kind === 'proto' ? [...run.sources.keys()] : []).toEqual(['a.proto']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
