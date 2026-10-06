import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSourceTool, runSourceTool } from '../../../../src/secrets/sources/exec.js';

async function toolDir(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-src-'));
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  }
  return dir;
}

describe.skipIf(process.platform === 'win32')('exec', () => {
  it('finds a tool on PATH and runs it with the arguments as given', async () => {
    const dir = await toolDir({ vault: 'printf "%s|" "$@"' });
    const env = { PATH: `${dir}:/usr/bin:/bin` };
    const path = await findSourceTool('vault', { env });
    expect(path).toBe(join(dir, 'vault'));
    expect(await runSourceTool(path, ['kv', 'get', 'a b', '$(x)'], { env })).toEqual({
      stdout: 'kv|get|a b|$(x)|',
      stderr: '',
      exitCode: 0,
    });
  });

  describe('darwin fixed directories', () => {
    const only = (...present: string[]) => ({
      isFile: (path: string) => Promise.resolve(present.includes(path)),
    });

    it('finds a tool in /opt/homebrew/bin when PATH lacks it', async () => {
      const path = await findSourceTool('vault', {
        env: { PATH: '/usr/bin:/bin' },
        platform: 'darwin',
        ...only('/opt/homebrew/bin/vault'),
      });
      expect(path).toBe('/opt/homebrew/bin/vault');
    });

    it('finds a tool in /usr/local/bin when PATH lacks it', async () => {
      const path = await findSourceTool('op', {
        env: { PATH: '/usr/bin:/bin' },
        platform: 'darwin',
        ...only('/usr/local/bin/op'),
      });
      expect(path).toBe('/usr/local/bin/op');
    });

    it('prefers a PATH hit over the fixed directories', async () => {
      const path = await findSourceTool('vault', {
        env: { PATH: '/custom/bin' },
        platform: 'darwin',
        ...only('/custom/bin/vault', '/opt/homebrew/bin/vault'),
      });
      expect(path).toBe('/custom/bin/vault');
    });

    it('finds a tool once when PATH already lists /opt/homebrew/bin', async () => {
      const path = await findSourceTool('vault', {
        env: { PATH: '/opt/homebrew/bin:/usr/bin' },
        platform: 'darwin',
        ...only('/opt/homebrew/bin/vault'),
      });
      expect(path).toBe('/opt/homebrew/bin/vault');
    });

    it('does not search them on another platform', async () => {
      await expect(
        findSourceTool('vault', {
          env: { PATH: '/usr/bin' },
          platform: 'linux',
          ...only('/opt/homebrew/bin/vault'),
        }),
      ).rejects.toMatchObject({ code: 'secret-source-unavailable' });
    });
  });

  it('passes the environment through', async () => {
    const dir = await toolDir({ op: 'printf "%s" "$VAULT_ADDR"' });
    const env = { PATH: `${dir}:/usr/bin:/bin`, VAULT_ADDR: 'https://v.example' };
    expect((await runSourceTool(await findSourceTool('op', { env }), [], { env })).stdout).toBe('https://v.example');
  });

  it('reports a non-zero exit with its stderr', async () => {
    const dir = await toolDir({ aws: 'echo "not logged in" >&2; exit 3' });
    const env = { PATH: `${dir}:/usr/bin:/bin` };
    expect(await runSourceTool(await findSourceTool('aws', { env }), [], { env })).toEqual({
      stdout: '',
      stderr: 'not logged in\n',
      exitCode: 3,
    });
  });

  it('fails a tool that runs past the timeout', async () => {
    const dir = await toolDir({ gcloud: '/bin/sleep 5' });
    const env = { PATH: `${dir}:/usr/bin:/bin` };
    await expect(
      runSourceTool(await findSourceTool('gcloud', { env }), [], { env, timeoutMs: 200 }),
    ).rejects.toMatchObject({
      code: 'secret-source-failed',
    });
  });

  it('fails output over the cap', async () => {
    const dir = await toolDir({ az: 'head -c 70000 /dev/zero | tr "\\0" a' });
    const env = { PATH: `${dir}:/usr/bin:/bin` };
    await expect(runSourceTool(await findSourceTool('az', { env }), [], { env })).rejects.toMatchObject({
      code: 'secret-source-failed',
    });
  });

  it('does not leak process.env variables to the tool', async () => {
    const dir = await toolDir({ probe: 'printf "%s" "${WB_EXEC_LEAK_PROBE-unset}"' });
    const env = { PATH: `${dir}:/usr/bin:/bin` };
    const oldValue = process.env.WB_EXEC_LEAK_PROBE;
    try {
      process.env.WB_EXEC_LEAK_PROBE = 'leaked';
      expect((await runSourceTool(await findSourceTool('probe', { env }), [], { env })).stdout).toBe('unset');
    } finally {
      if (oldValue === undefined) {
        delete process.env.WB_EXEC_LEAK_PROBE;
      } else {
        process.env.WB_EXEC_LEAK_PROBE = oldValue;
      }
    }
  });

  it('says which tool is missing and where to get it', async () => {
    let error: unknown;
    try {
      await findSourceTool('vault', { env: { PATH: '/nonexistent' } });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: 'secret-source-unavailable',
    });
    expect((error as Error).message).toContain('developer.hashicorp.com');
  });

  it('skips a directory named like the tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-src-'));
    await mkdir(join(dir, 'op'));
    await expect(findSourceTool('op', { env: { PATH: dir } })).rejects.toMatchObject({
      code: 'secret-source-unavailable',
    });
  });
});

describe('findSourceTool on win32', () => {
  const files = new Set(['C:\\tools\\vault.exe', 'C:\\tools\\az.cmd']);
  const isFile = (path: string): Promise<boolean> => Promise.resolve(files.has(path));
  const env = { Path: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('takes an .exe', async () => {
    expect(await findSourceTool('vault', { env, platform: 'win32', isFile })).toBe('C:\\tools\\vault.exe');
  });

  it('refuses a .cmd wrapper', async () => {
    let error: unknown;
    try {
      await findSourceTool('az', { env, platform: 'win32', isFile });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: 'secret-source-unsupported',
    });
    expect((error as Error).message).toContain('az.cmd');
  });
});
