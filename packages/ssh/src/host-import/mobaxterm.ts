import { SshModelError } from '../errors.js';
import type { ImportedSession, SessionSource } from './sessions.js';

/** The bookmark type of an SSH session. */
const SSH_TYPE = '109';
/** Positions in an SSH bookmark's first `%`-separated block. */
const HOST = 1;
const PORT = 2;
const USER = 3;
const GATEWAY_HOST = 8;
const GATEWAY_PORT = 9;
const GATEWAY_USER = 10;
const KEY_FILE = 14;

/** The words MobaXterm writes for characters its format reserves. */
const RESERVED: readonly (readonly [string, string])[] = [
  ['__PERCENT__', '%'],
  ['__DIEZE__', '#'],
  ['__PTVIRG__', ';'],
  ['__DBLQUO__', '"'],
  ['__PIPE__', '|'],
];
const unescape = (value: string): string => RESERVED.reduce((text, [word, ch]) => text.split(word).join(ch), value);

const isBookmarks = (section: string): boolean => section === 'Bookmarks' || section.startsWith('Bookmarks_');
const PASSWORD_SECTIONS = new Set(['Passwords', 'Credentials']);

/**
 * The SSH bookmarks in a MobaXterm configuration (`.mobaconf`, the `MobaXterm.ini` layout) or session
 * export (`.mxtsessions`). `SubRep` names a bookmark section's folder; saved passwords are counted, never kept.
 * @throws SshModelError `ssh-import-unreadable` when the file has no bookmark section.
 */
export function parseMobaXterm(text: string): SessionSource {
  const sessions: ImportedSession[] = [];
  const skipped: { line: number; keyword: string; why: string }[] = [];
  let passwords = 0;
  let section = '';
  let folder: string[] = [];
  let sawBookmarks = false;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const lineNo = index + 1;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      folder = [];
      if (isBookmarks(section)) sawBookmarks = true;
      return;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) return;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (PASSWORD_SECTIONS.has(section)) {
      passwords += 1;
      return;
    }
    if (!isBookmarks(section)) return;
    if (key === 'SubRep') {
      folder = value.split('\\').filter((part) => part !== '');
      return;
    }
    if (key === 'ImgNum' || !value.startsWith('#')) return;

    const name = unescape(key);
    const [, type, settings = ''] = value.split('#');
    if (type !== SSH_TYPE) {
      skipped.push({ line: lineNo, keyword: name, why: 'not an SSH session' });
      return;
    }
    const fields = settings.split('%');
    const field = (at: number): string | undefined => {
      const v = unescape(fields[at] ?? '').trim();
      return v === '' ? undefined : v;
    };
    const address = field(HOST);
    if (address === undefined) {
      skipped.push({ line: lineNo, keyword: name, why: 'has no host name' });
      return;
    }
    const portText = field(PORT);
    const port = portText !== undefined && /^\d{1,5}$/.test(portText) ? Number(portText) : undefined;
    const user = field(USER);
    const keyFile = field(KEY_FILE);

    let jump: string | undefined;
    const gateway = field(GATEWAY_HOST);
    if (gateway?.includes('|')) {
      skipped.push({
        line: lineNo,
        keyword: 'gateway',
        why: `${name}: several gateways in a row are not imported; imported without a jump`,
      });
    } else if (gateway !== undefined) {
      const gatewayUser = field(GATEWAY_USER);
      const gatewayPort = field(GATEWAY_PORT);
      const portPart = gatewayPort === undefined || gatewayPort === '22' ? '' : `:${gatewayPort}`;
      jump = `${gatewayUser === undefined ? '' : `${gatewayUser}@`}${gateway}${portPart}`;
    }

    sessions.push({
      name,
      line: lineNo,
      folder,
      address,
      ...(port === undefined ? {} : { port }),
      ...(user === undefined ? {} : { user }),
      ...(keyFile === undefined ? {} : { keyFile }),
      ...(jump === undefined ? {} : { jump }),
    });
  });

  if (!sawBookmarks) {
    throw new SshModelError('ssh-import-unreadable', 'The file is not a MobaXterm session file (no bookmarks)');
  }
  return { format: 'mobaxterm', sessions, skipped, ignored: [], notes: [], passwords };
}
