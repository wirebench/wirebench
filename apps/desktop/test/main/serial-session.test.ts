import * as mock from '@serialport/binding-mock';
import * as stream from '@serialport/stream';
import { SERIAL_DEFAULTS, type SessionExit } from '@wirebench/ssh';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSerialPorts,
  openSerialSession,
  serialOpenErrorCode,
  type SerialBinding,
  type SerialModules,
} from '../../src/main/serial-session.js';

// The packages' typings do not resolve through their `exports`: what the tests use of them, typed.
interface MockPort {
  readonly openOptions: Record<string, unknown>;
  readonly recording: Buffer;
  emitData(data: Buffer | string): void;
  read: (...args: unknown[]) => Promise<unknown>;
}
interface MockApi extends SerialBinding {
  createPort(path: string, options?: { record?: boolean; manufacturer?: string }): void;
  reset(): void;
  open(options: unknown): Promise<MockPort>;
}
const MockBinding = (mock as unknown as { MockBinding: MockApi }).MockBinding;

let opened: MockPort | undefined;
const binding: SerialBinding & Pick<MockApi, 'open'> = {
  list: () => MockBinding.list(),
  async open(options) {
    opened = await MockBinding.open(options);
    return opened;
  },
};
const modules: SerialModules = {
  binding,
  SerialPortStream: (stream as unknown as Pick<SerialModules, 'SerialPortStream'>).SerialPortStream,
};

afterEach(() => {
  MockBinding.reset();
  opened = undefined;
});

const nextExit = (session: { onExit: (l: (e: SessionExit) => void) => () => void }) =>
  new Promise<SessionExit>((resolve) => session.onExit(resolve));

describe('serial ports (#426)', () => {
  it('lists this machine’s ports sorted by path, with the maker when known', async () => {
    MockBinding.createPort('/dev/ttyUSB10', { manufacturer: 'FTDI' });
    MockBinding.createPort('/dev/ttyUSB2', { manufacturer: ' ' });
    const ports = await listSerialPorts(modules);
    expect(ports.map((p) => p.path)).toEqual(['/dev/ttyUSB2', '/dev/ttyUSB10']);
    expect(ports[0]!.label).toBeUndefined();
    expect(ports[1]!.label).toBe('FTDI');
  });

  it('opens with the line settings and passes bytes both ways unchanged', async () => {
    MockBinding.createPort('/dev/ttyUSB0', { record: true });
    const session = await openSerialSession({
      path: '/dev/ttyUSB0',
      line: { ...SERIAL_DEFAULTS, baud: 9600, dataBits: 7, parity: 'even', stopBits: 2, flowControl: 'rtscts' },
      modules,
    });
    expect(opened!.openOptions).toMatchObject({
      baudRate: 9600,
      dataBits: 7,
      parity: 'even',
      stopBits: 2,
      rtscts: true,
    });
    expect(session.agentForwarding).toBe('off');

    const received: number[] = [];
    session.onData((data) => received.push(...data));
    opened!.emitData(Buffer.from([0x0d, 0xff, 0x00, 0x41]));
    await expect.poll(() => received).toEqual([0x0d, 0xff, 0x00, 0x41]);

    session.write(new Uint8Array([0xff, 0x0d]));
    await expect.poll(() => [...opened!.recording]).toEqual([0xff, 0x0d]);
    session.resize(120, 40);
    expect(await session.exec('uname', 1000)).toBe('');

    const exit = nextExit(session);
    session.close();
    expect(await exit).toEqual({ code: null, reason: 'closed' });
  });

  it('XON/XOFF sets both software flow-control directions', async () => {
    MockBinding.createPort('/dev/ttyS0');
    const session = await openSerialSession({
      path: '/dev/ttyS0',
      line: { ...SERIAL_DEFAULTS, flowControl: 'xonxoff' },
      modules,
    });
    expect(opened!.openOptions).toMatchObject({ xon: true, xoff: true, rtscts: false });
    session.close();
  });

  it('the adapter going away mid-session ends it as lost', async () => {
    MockBinding.createPort('/dev/ttyUSB0');
    const session = await openSerialSession({ path: '/dev/ttyUSB0', line: SERIAL_DEFAULTS, modules });
    const exit = nextExit(session);
    // The pending read finishes with this data; the next one finds the device gone.
    opened!.read = () => Promise.reject(new Error('Input/output error'));
    opened!.emitData('x');
    expect(await exit).toEqual({ code: null, reason: 'lost' });
  });

  it('a port that is not there or already open is refused with its code', async () => {
    await expect(openSerialSession({ path: '/dev/nope', line: SERIAL_DEFAULTS, modules })).rejects.toMatchObject({
      code: 'serial-device-missing',
      details: { device: '/dev/nope' },
    });
    MockBinding.createPort('/dev/ttyUSB0');
    const first = await openSerialSession({ path: '/dev/ttyUSB0', line: SERIAL_DEFAULTS, modules });
    await expect(openSerialSession({ path: '/dev/ttyUSB0', line: SERIAL_DEFAULTS, modules })).rejects.toMatchObject({
      code: 'serial-device-busy',
    });
    first.close();
  });

  it('reads the platform messages as missing, busy or no permission', () => {
    expect(serialOpenErrorCode('Error: No such file or directory, cannot open /dev/ttyUSB0')).toBe(
      'serial-device-missing',
    );
    expect(serialOpenErrorCode('Opening COM9: File not found')).toBe('serial-device-missing');
    expect(serialOpenErrorCode('Error Resource temporarily unavailable Cannot lock port')).toBe('serial-device-busy');
    expect(serialOpenErrorCode('Error: Resource busy, cannot open /dev/tty.usbserial')).toBe('serial-device-busy');
    expect(serialOpenErrorCode('Opening COM3: Access denied')).toBe('serial-device-busy');
    expect(serialOpenErrorCode('Error: Permission denied, cannot open /dev/ttyUSB0')).toBe('serial-permission');
  });
});
