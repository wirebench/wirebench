import { SshModelError } from '../errors.js';
import type { ImportedForward, ImportedSession, SessionSource } from './sessions.js';

/** An element of the export: `<key>`, `<string>`, `<dword>` or `<array>`, with its `name` attribute. */
interface XmlNode {
  readonly tag: string;
  readonly name: string | undefined;
  readonly line: number;
  text: string;
  readonly children: XmlNode[];
}

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const end = text[i] === '&' ? text.indexOf(';', i) : -1;
    const entity = end === -1 || end - i > 10 ? undefined : text.slice(i + 1, end);
    let ch: string | undefined;
    if (entity !== undefined) {
      if (entity in ENTITIES) ch = ENTITIES[entity];
      else if (/^#\d{1,7}$/.test(entity)) ch = String.fromCodePoint(Number(entity.slice(1)));
      else if (/^#x[0-9A-Fa-f]{1,6}$/.test(entity)) ch = String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (ch === undefined) out += text[i];
    else {
      out += ch;
      i = end;
    }
  }
  return out;
}

/** The value of `name="…"` in a start tag. */
function nameAttribute(tag: string): string | undefined {
  const at = tag.indexOf(' name="');
  if (at === -1) return undefined;
  const end = tag.indexOf('"', at + 7);
  return end === -1 ? undefined : decodeEntities(tag.slice(at + 7, end));
}

const notExport = (): SshModelError =>
  new SshModelError('ssh-import-unreadable', 'The file is not a SecureCRT session export (XML)');

/** The element tree of the export: a scan over `<`…`>`, with no regular expression over the document. */
function readXml(text: string): XmlNode {
  const root: XmlNode = { tag: '#root', name: undefined, line: 1, text: '', children: [] };
  const stack: XmlNode[] = [root];
  let line = 1;
  let pos = 0;
  const advance = (to: number): void => {
    for (let i = pos; i < to; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    pos = to;
  };
  while (pos < text.length) {
    const open = text.indexOf('<', pos);
    const top = stack[stack.length - 1] as XmlNode;
    if (open === -1) break;
    top.text += text.slice(pos, open);
    advance(open);
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open);
      if (end === -1) throw notExport();
      advance(end + 3);
      continue;
    }
    const close = text.indexOf('>', open);
    if (close === -1) throw notExport();
    const tag = text.slice(open + 1, close);
    advance(close + 1);
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    if (tag.startsWith('/')) {
      if (stack.length === 1 || top.tag !== tag.slice(1).trim()) throw notExport();
      stack.pop();
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const space = body.search(/\s/);
    const node: XmlNode = {
      tag: space === -1 ? body : body.slice(0, space),
      name: nameAttribute(body),
      line,
      text: '',
      children: [],
    };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1) throw notExport();
  return root;
}

/** `name|[bind,]port|flag|host|port|…`: a row of a forward table. */
function readForwardRow(row: string, type: 'local' | 'remote'): ImportedForward | undefined {
  const fields = row.split('|');
  if (fields.length < 5) return undefined;
  const listen = (fields[1] as string).split(',');
  const portText = listen.at(-1) as string;
  const host = fields[3] as string;
  const targetPort = fields[4] as string;
  if (!/^\d{1,5}$/.test(portText) || !/^\d{1,5}$/.test(targetPort) || host === '') return undefined;
  const bind = listen.length === 2 ? (listen[0] as string) : '';
  const target = host.includes(':') ? `[${host}]:${targetPort}` : `${host}:${targetPort}`;
  return { type, port: Number(portText), ...(bind === '' ? {} : { bind }), target };
}

const FORWARD_TABLES = [
  ['Port Forward Table V2', 'local'],
  ['Reverse Forward Table V2', 'remote'],
] as const;

/**
 * The SSH2 sessions in a SecureCRT XML export (Tools → Export Settings). Folders are the keys above a
 * session under `Sessions`; a saved password is counted, never kept.
 * @throws SshModelError `ssh-import-unreadable` when the file is not such an export.
 */
export function parseSecureCrtXml(text: string): SessionSource {
  const root = readXml(text);
  const vanDyke = root.children.find((n) => n.tag === 'VanDyke');
  const top = vanDyke?.children.find((n) => n.tag === 'key' && n.name === 'Sessions');
  if (!top) throw notExport();

  const sessions: ImportedSession[] = [];
  const skipped: { line: number; keyword: string; why: string }[] = [];
  let passwords = 0;

  const visit = (key: XmlNode, folder: readonly string[]): void => {
    const name = key.name ?? '';
    const values = new Map(key.children.filter((c) => c.tag !== 'key').map((c) => [c.name ?? '', c]));
    const value = (field: string): string | undefined => {
      const text = decodeEntities(values.get(field)?.text ?? '').trim();
      return text === '' ? undefined : text;
    };
    if (!values.has('Hostname') && !values.has('Protocol Name')) {
      for (const child of key.children) if (child.tag === 'key') visit(child, [...folder, name]);
      return;
    }
    if (folder.length === 0 && name === 'Default') return;
    if (value('Password V2') !== undefined || value('Password') !== undefined) passwords += 1;
    const protocol = value('Protocol Name') ?? 'SSH2';
    if (protocol !== 'SSH2') {
      skipped.push({ line: key.line, keyword: name, why: `a ${protocol} session, not SSH2` });
      return;
    }
    const address = value('Hostname');
    if (address === undefined) {
      skipped.push({ line: key.line, keyword: name, why: 'has no host name' });
      return;
    }
    const portText = value('[SSH2] Port');
    const port = portText !== undefined && /^\d{1,5}$/.test(portText) ? Number(portText) : undefined;
    const user = value('Username');
    const identity = value('Identity Filename V2');
    const keyFile = identity === undefined ? undefined : identity.split('::')[0];

    let jump: string | undefined;
    const firewall = value('Firewall Name');
    if (firewall?.startsWith('Session:')) jump = firewall.slice('Session:'.length);
    else if (firewall !== undefined && firewall !== 'None') {
      skipped.push({
        line: values.get('Firewall Name')?.line ?? key.line,
        keyword: 'Firewall Name',
        why: `${name}: only a session firewall becomes a jump host; imported without it`,
      });
    }

    const forwards: ImportedForward[] = [];
    for (const [table, type] of FORWARD_TABLES) {
      const array = values.get(table);
      let unread = 0;
      for (const row of array?.children ?? []) {
        const forward = readForwardRow(decodeEntities(row.text).trim(), type);
        if (forward) forwards.push(forward);
        else unread += 1;
      }
      if (unread > 0) {
        skipped.push({
          line: array?.line ?? key.line,
          keyword: table,
          why: `${name}: ${String(unread)} port forward${unread === 1 ? '' : 's'} could not be read`,
        });
      }
    }

    sessions.push({
      name,
      line: key.line,
      folder,
      address,
      ...(port === undefined ? {} : { port }),
      ...(user === undefined ? {} : { user }),
      ...(keyFile === undefined || keyFile === '' ? {} : { keyFile }),
      ...(jump === undefined || jump === '' ? {} : { jump }),
      ...(forwards.length === 0 ? {} : { forwards }),
    });
  };
  for (const child of top.children) if (child.tag === 'key') visit(child, []);
  return { format: 'securecrt', sessions, skipped, ignored: [], notes: [], passwords };
}
