import type { GroupEntry, HostEntry, HostsFile } from './model.js';

export function walk(file: HostsFile): Array<{
  entry: HostEntry | GroupEntry;
  kind: 'host' | 'group';
  path: readonly string[];
}> {
  const out: Array<{ entry: HostEntry | GroupEntry; kind: 'host' | 'group'; path: readonly string[] }> = [];
  const visit = (groups: GroupEntry[], hosts: HostEntry[], path: readonly string[]): void => {
    for (const group of groups) {
      out.push({ entry: group, kind: 'group', path });
      visit(group.groups, group.hosts, [...path, group.id]);
    }
    for (const host of hosts) out.push({ entry: host, kind: 'host', path });
  };
  visit(file.groups, file.hosts, []);
  return out;
}
