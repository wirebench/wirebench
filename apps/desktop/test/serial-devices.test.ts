// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SERIAL_DEVICES_FILE, SerialDeviceStore } from '../src/main/serial-devices.js';

const fileIn = (): string => join(mkdtempSync(join(tmpdir(), 'wb-serial-')), 'nested', SERIAL_DEVICES_FILE);

describe('SerialDeviceStore (#426)', () => {
  it('keeps a device per workspace and host, and forgets it on null', async () => {
    const file = fileIn();
    const store = new SerialDeviceStore(file);
    expect(await store.get('ws-1', 'lab')).toBeUndefined();
    await store.set('ws-1', 'lab', ' /dev/ttyUSB0 ');
    await store.set('ws-2', 'lab', 'COM3');
    expect(await store.get('ws-1', 'lab')).toBe('/dev/ttyUSB0');
    expect(await store.get('ws-2', 'lab')).toBe('COM3');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      devices: { 'ws-1\nlab': '/dev/ttyUSB0', 'ws-2\nlab': 'COM3' },
    });
    await store.set('ws-1', 'lab', null);
    expect(await store.get('ws-1', 'lab')).toBeUndefined();
    expect(await new SerialDeviceStore(file).get('ws-2', 'lab')).toBe('COM3');
  });

  it('two saves at once both land', async () => {
    const store = new SerialDeviceStore(fileIn());
    await Promise.all([store.set('w', 'a', 'COM1'), store.set('w', 'b', 'COM2')]);
    expect([await store.get('w', 'a'), await store.get('w', 'b')]).toEqual(['COM1', 'COM2']);
  });

  it('refuses an empty device or one with a line break', async () => {
    const store = new SerialDeviceStore(fileIn());
    await expect(store.set('w', 'a', '  ')).rejects.toMatchObject({ code: 'serial-device-invalid' });
    await expect(store.set('w', 'a', 'COM1\nCOM2')).rejects.toMatchObject({ code: 'serial-device-invalid' });
  });

  it('a malformed file reads empty, is reported once, and the next save replaces it', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wb-serial-')), SERIAL_DEVICES_FILE);
    writeFileSync(file, '{ not json');
    const log = vi.fn();
    const store = new SerialDeviceStore(file, log);
    expect(await store.get('w', 'a')).toBeUndefined();
    expect(await store.get('w', 'b')).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    await store.set('w', 'a', 'COM1');
    expect(await store.get('w', 'a')).toBe('COM1');
  });
});
