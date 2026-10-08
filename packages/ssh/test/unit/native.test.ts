import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

it('ssh2 is used without its optional native binding (pure-JS ciphers)', () => {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('ssh2/package.json'));
  expect(existsSync(join(root, 'lib/protocol/crypto/build/Release/sshcrypto.node'))).toBe(false);
  expect(() => {
    require('ssh2');
  }).not.toThrow();
});
