import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectError } from '../../../src/errors.js';
import type { Attachment } from '../../../src/project/model.js';
import {
  attachmentFile,
  attachmentsIndexFile,
  createFileAttachmentResolver,
  listAttachments,
  pruneAttachments,
  putAttachment,
  readAttachment,
} from '../../../src/project/attachments-cache.js';
import { tempProjectDir } from './fixture.js';

const INVOICE = new TextEncoder().encode('%PDF-1.4 invoice');
const NOTE = new TextEncoder().encode('a note');
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const dirs: string[] = [];
async function projectDir(): Promise<string> {
  const dir = await tempProjectDir();
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'A1',
    name: 'invoice.pdf',
    contentType: 'application/pdf',
    size: INVOICE.length,
    type: 'MIME',
    contentId: 'A1@wirebench',
    cached: true,
    source: { kind: 'cache', sha256: sha(INVOICE) },
    ...overrides,
  };
}

describe('putAttachment', () => {
  it('stores bytes content-addressed and records them in the index', async () => {
    const dir = await projectDir();
    const put = await putAttachment(dir, INVOICE, { originalName: 'invoice.pdf', contentType: 'application/pdf' });

    expect(put).toEqual({ sha256: sha(INVOICE), size: INVOICE.length });
    expect(new Uint8Array(await readFile(attachmentFile(dir, put.sha256)))).toEqual(INVOICE);
    expect(await readFile(attachmentsIndexFile(dir), 'utf8')).toContain(put.sha256);
    expect(await listAttachments(dir)).toEqual([
      { sha256: put.sha256, originalName: 'invoice.pdf', contentType: 'application/pdf', size: INVOICE.length },
    ]);
  });

  it('is idempotent for identical bytes and keeps distinct ones apart', async () => {
    const dir = await projectDir();
    const first = await putAttachment(dir, INVOICE, { originalName: 'invoice.pdf', contentType: 'application/pdf' });
    const again = await putAttachment(dir, INVOICE, { originalName: 'copy.pdf', contentType: 'application/pdf' });
    await putAttachment(dir, NOTE, { originalName: 'note.txt', contentType: 'text/plain' });

    expect(again.sha256).toBe(first.sha256);
    const listed = await listAttachments(dir);
    expect(listed).toHaveLength(2);
    // The first name wins: the bytes are the identity, and re-adding must not rewrite history.
    expect(listed.find((entry) => entry.sha256 === first.sha256)?.originalName).toBe('invoice.pdf');
  });
});

describe('putAttachment recovery', () => {
  it('rewrites a blob the index knows about but the folder has lost', async () => {
    const dir = await projectDir();
    const put = await putAttachment(dir, INVOICE, { originalName: 'i.pdf', contentType: 'application/pdf' });
    await rm(attachmentFile(dir, put.sha256));

    await putAttachment(dir, INVOICE, { originalName: 'i.pdf', contentType: 'application/pdf' });
    expect(await readAttachment(dir, put.sha256)).toEqual(INVOICE);
    expect(await listAttachments(dir)).toHaveLength(1);
  });
});

describe('readAttachment', () => {
  it('reads bytes back', async () => {
    const dir = await projectDir();
    const put = await putAttachment(dir, INVOICE, { originalName: 'i.pdf', contentType: 'application/pdf' });
    expect(await readAttachment(dir, put.sha256)).toEqual(INVOICE);
  });

  it('raises a ProjectError for an unknown digest', async () => {
    const dir = await projectDir();
    await expect(readAttachment(dir, 'f'.repeat(64))).rejects.toThrow(ProjectError);
    await expect(readAttachment(dir, 'f'.repeat(64))).rejects.toMatchObject({ code: 'attachment-missing' });
  });

  it('rejects a digest that is not a plain sha256', async () => {
    const dir = await projectDir();
    await expect(readAttachment(dir, '../escape')).rejects.toMatchObject({ code: 'attachment-invalid-digest' });
  });
});

describe('listAttachments / pruneAttachments', () => {
  it('returns nothing for a project with no attachments', async () => {
    expect(await listAttachments(await projectDir())).toEqual([]);
  });

  it('removes only unreferenced files and index entries', async () => {
    const dir = await projectDir();
    const keep = await putAttachment(dir, INVOICE, { originalName: 'i.pdf', contentType: 'application/pdf' });
    const drop = await putAttachment(dir, NOTE, { originalName: 'n.txt', contentType: 'text/plain' });

    const pruned = await pruneAttachments(dir, [keep.sha256]);
    expect(pruned.removed).toEqual([drop.sha256]);
    expect((await listAttachments(dir)).map((entry) => entry.sha256)).toEqual([keep.sha256]);
    expect(await readAttachment(dir, keep.sha256)).toEqual(INVOICE);
    await expect(readAttachment(dir, drop.sha256)).rejects.toThrow(ProjectError);
  });

  it('also removes a stray file the index never knew about', async () => {
    const dir = await projectDir();
    const stray = sha(NOTE);
    await mkdir(join(dir, 'attachments'), { recursive: true });
    await writeFile(attachmentFile(dir, stray), Buffer.from(NOTE));

    expect((await pruneAttachments(dir, [])).removed).toEqual([stray]);
  });
});

describe('createFileAttachmentResolver', () => {
  it('reads a cached attachment out of the project', async () => {
    const dir = await projectDir();
    await putAttachment(dir, INVOICE, { originalName: 'i.pdf', contentType: 'application/pdf' });
    const resolve = createFileAttachmentResolver(dir);
    expect(await resolve(attachment())).toEqual(INVOICE);
  });

  it('reads a path attachment relative to the resource root, then to the project', async () => {
    const dir = await projectDir();
    await mkdir(join(dir, 'res'), { recursive: true });
    await writeFile(join(dir, 'res', 'a.txt'), Buffer.from(NOTE));
    await writeFile(join(dir, 'b.txt'), Buffer.from(INVOICE));

    const resolve = createFileAttachmentResolver(dir, join(dir, 'res'));
    expect(await resolve(attachment({ source: { kind: 'path', path: 'a.txt' } }))).toEqual(NOTE);
    expect(await resolve(attachment({ source: { kind: 'path', path: 'b.txt' } }))).toEqual(INVOICE);
    expect(await resolve(attachment({ source: { kind: 'path', path: join(dir, 'b.txt') } }))).toEqual(INVOICE);
  });

  it('raises a ProjectError naming the attachment when nothing can be read', async () => {
    const dir = await projectDir();
    const resolve = createFileAttachmentResolver(dir);
    await expect(resolve(attachment({ source: { kind: 'path', path: 'nope.txt' } }))).rejects.toMatchObject({
      code: 'attachment-unreadable',
    });
    await expect(resolve(attachment({ source: { kind: 'path', path: 'nope.txt' } }))).rejects.toThrow(/invoice\.pdf/);
  });
});
