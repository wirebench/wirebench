import { describe, expect, it } from 'vitest';
import { saveProject } from '../../../src/project/save.js';
import { readBytes, sampleProject, tempProjectDir } from './fixture.js';

const REQUEST_PATH = 'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Request 1.xml';
const BACKUP_REQUEST = `${REQUEST_PATH}.bak`;

describe('saveProject — timestamped backups', () => {
  it('never overwrites a previous backup: two consecutive updates leave two distinct .bak files', async () => {
    const dir = await tempProjectDir();
    const original = sampleProject();
    await saveProject(original, dir);
    const originalEnvelope = (await readBytes(dir, REQUEST_PATH)).toString('utf8');

    const withEdit = (envelopeXml: string) => ({
      ...original,
      interfaces: original.interfaces.map((iface) =>
        iface.name === 'CountryInfo'
          ? {
              ...iface,
              operations: iface.operations.map((operation) => ({
                ...operation,
                requests: operation.requests.map((request) =>
                  request.name === 'Request 1' ? { ...request, envelopeXml } : request,
                ),
              })),
            }
          : iface,
      ),
    });

    const first = withEdit(originalEnvelope.replace('1.1', '2.1'));
    const firstSave = await saveProject(first, dir, {
      backups: [BACKUP_REQUEST],
      now: () => new Date('2026-01-01T10:00:00.000Z'),
    });
    expect(firstSave.backups).toHaveLength(1);
    const firstBackupPath = firstSave.backups[0] ?? '';
    expect(firstBackupPath).not.toBe(BACKUP_REQUEST);
    expect(firstBackupPath).toMatch(
      /^interfaces\/CountryInfo\/operations\/ListOfCountryNamesByCode\/Request 1\.\d{8}-\d{6}\.xml\.bak$/,
    );
    expect((await readBytes(dir, firstBackupPath)).toString('utf8')).toBe(originalEnvelope);

    const second = withEdit(originalEnvelope.replace('1.1', '3.1'));
    const secondSave = await saveProject(second, dir, {
      backups: [BACKUP_REQUEST],
      now: () => new Date('2026-01-01T10:00:01.000Z'),
    });
    expect(secondSave.backups).toHaveLength(1);
    const secondBackupPath = secondSave.backups[0] ?? '';

    expect(secondBackupPath).not.toBe(firstBackupPath);
    // The first backup file is untouched: it still holds the original envelope.
    expect((await readBytes(dir, firstBackupPath)).toString('utf8')).toBe(originalEnvelope);
    expect((await readBytes(dir, secondBackupPath)).toString('utf8')).toBe(
      first.interfaces
        .find((i) => i.name === 'CountryInfo')
        ?.operations.find((o) => o.requests.some((r) => r.name === 'Request 1'))
        ?.requests.find((r) => r.name === 'Request 1')?.envelopeXml ?? '',
    );
  });

  it('uses UTC and pads single digits into YYYYMMDD-HHmmss', async () => {
    const dir = await tempProjectDir();
    const project = sampleProject();
    await saveProject(project, dir);
    const edited = {
      ...project,
      interfaces: project.interfaces.map((iface) =>
        iface.name === 'CountryInfo'
          ? {
              ...iface,
              operations: iface.operations.map((operation) => ({
                ...operation,
                requests: operation.requests.map((request) =>
                  request.name === 'Request 1'
                    ? { ...request, envelopeXml: `${request.envelopeXml}<!--x-->` }
                    : request,
                ),
              })),
            }
          : iface,
      ),
    };
    const result = await saveProject(edited, dir, {
      backups: [BACKUP_REQUEST],
      now: () => new Date(Date.UTC(2026, 0, 5, 3, 4, 5)),
    });
    expect(result.backups[0]).toBe(
      'interfaces/CountryInfo/operations/ListOfCountryNamesByCode/Request 1.20260105-030405.xml.bak',
    );
  });
});
