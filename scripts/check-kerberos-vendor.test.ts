import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkKerberosVendor } from './check-kerberos-vendor.ts';

async function resources(prebuilds: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'res-'));
  for (const prebuild of prebuilds) {
    await mkdir(join(dir, 'kerberos', prebuild), { recursive: true });
    await writeFile(join(dir, 'kerberos', prebuild, 'kerberos.node'), 'x');
  }
  return dir;
}

describe('checkKerberosVendor', () => {
  it('passes a single-architecture build that carries only its own binding', async () => {
    const dir = await resources(['linux-x64']);
    expect(checkKerberosVendor({ target: 'linux-x64', resourcesDirs: [dir], loadHost: false })).toEqual([]);
  });

  it('names a binding of another architecture in a single-architecture build', async () => {
    const dir = await resources(['linux-x64', 'linux-arm64']);
    expect(checkKerberosVendor({ target: 'linux-x64', resourcesDirs: [dir], loadHost: false })).toEqual([
      `${join(dir, 'kerberos', 'linux-arm64')} is not a binding a linux-x64 build needs`,
    ]);
  });

  it('wants every pinned binding of the platform when the target names no architecture', async () => {
    const dir = await resources(['darwin-arm64']);
    expect(checkKerberosVendor({ target: 'darwin', resourcesDirs: [dir], loadHost: false })).toEqual([
      `${join(dir, 'kerberos', 'darwin-x64', 'kerberos.node')} is missing`,
    ]);
    const both = await resources(['darwin-arm64', 'darwin-x64']);
    expect(checkKerberosVendor({ target: 'darwin', resourcesDirs: [both], loadHost: false })).toEqual([]);
  });

  it('wants no binding in a Windows arm64 build, since there is no arm64 prebuild', async () => {
    const empty = await resources([]);
    expect(checkKerberosVendor({ target: 'win32-arm64', resourcesDirs: [empty], loadHost: false })).toEqual([]);
    const x64 = await resources(['win32-x64']);
    expect(checkKerberosVendor({ target: 'win32-arm64', resourcesDirs: [x64], loadHost: false })).toEqual([
      `${join(x64, 'kerberos', 'win32-x64')} is not a binding a win32-arm64 build needs`,
    ]);
  });

  it('checks every resources directory it is given', async () => {
    const complete = await resources(['win32-x64']);
    const empty = await resources([]);
    expect(checkKerberosVendor({ target: 'win32-x64', resourcesDirs: [complete, empty], loadHost: false })).toEqual([
      `${join(empty, 'kerberos', 'win32-x64', 'kerberos.node')} is missing`,
    ]);
  });
});

describe('checkKerberosVendor loading', () => {
  it.skipIf(!['darwin', 'linux'].includes(process.platform))(
    'loads the host binding by absolute path, so a relative resources dir is not read as a package name',
    async () => {
      const dir = await resources([`${process.platform}-arm64`, `${process.platform}-x64`]);
      const problems = checkKerberosVendor({
        target: process.platform,
        resourcesDirs: [relative(process.cwd(), dir)],
        loadHost: true,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('does not load');
      expect(problems[0]).not.toContain('Cannot find module');
    },
  );
});
