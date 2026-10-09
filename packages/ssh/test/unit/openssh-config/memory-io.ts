import type { SshConfigIo } from '../../../src/openssh-config/load.js';

/** An in-memory home at /home/u. A value of `Error` makes the read fail with that error. */
export function memoryIo(files: Record<string, string | Error>): SshConfigIo & { reads: string[] } {
  const reads: string[] = [];
  return {
    home: '/home/u',
    reads,
    readFile(path) {
      reads.push(path);
      const value = files[path];
      if (value === undefined) return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
    },
    glob(pattern) {
      const re = new RegExp(
        `^${pattern
          .replace(/[.+^${}()|\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')}$`,
      );
      return Promise.resolve(Object.keys(files).filter((f) => re.test(f)));
    },
  };
}
