import { randomUUID } from 'node:crypto';
import { WirebenchError } from '@wirebench/engine';
import type { SerialLine, SessionExit, SshSession } from '@wirebench/ssh';
/**
 * Serial consoles (#426): a serial line opened as a terminal session. The binding is a native module with
 * prebuilds for the platforms the app ships on, loaded on first use; a platform without one reports
 * `serial-unavailable` and nothing else changes.
 *
 * The packages' own typings do not resolve through their `exports`, so the little used of them is typed here.
 */
export interface SerialPortInfo {
  readonly path: string;
  readonly manufacturer?: string | undefined;
  readonly serialNumber?: string | undefined;
}

/** The hardware binding: lists the ports, and is handed to the stream as is. */
export interface SerialBinding {
  list(): Promise<SerialPortInfo[]>;
}

export interface SerialStreamOptions {
  readonly binding: SerialBinding;
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits: SerialLine['dataBits'];
  readonly parity: SerialLine['parity'];
  readonly stopBits: SerialLine['stopBits'];
  readonly rtscts: boolean;
  readonly xon: boolean;
  readonly xoff: boolean;
  readonly autoOpen: false;
}

export interface SerialStream {
  readonly isOpen: boolean;
  open(callback: (error: Error | null) => void): void;
  write(data: Buffer): boolean;
  close(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'error' | 'close', listener: () => void): this;
}

export interface SerialModules {
  readonly binding: SerialBinding;
  readonly SerialPortStream: new (options: SerialStreamOptions) => SerialStream;
}

/** One port this machine has, as the pickers show it. */
export interface SerialPortEntry {
  readonly path: string;
  /** The maker or the OS's name for it, when known (`FTDI`, `USB Serial Device`). */
  readonly label?: string;
  readonly serialNumber?: string;
}

let loading: Promise<SerialModules> | undefined;

/** The binding and the stream, imported once. */
export function loadSerial(): Promise<SerialModules> {
  loading ??= Promise.all([import('@serialport/bindings-cpp'), import('@serialport/stream')]).then(
    ([bindings, stream]) => ({
      binding: (bindings as unknown as { autoDetect(): SerialBinding }).autoDetect(),
      SerialPortStream: (stream as unknown as Pick<SerialModules, 'SerialPortStream'>).SerialPortStream,
    }),
    (error: unknown) => {
      loading = undefined;
      throw new WirebenchError('serial-unavailable', 'Serial consoles are not available on this computer', {
        cause: error,
      });
    },
  );
  return loading;
}

/** This machine's serial ports, sorted by path. */
export async function listSerialPorts(modules?: SerialModules): Promise<SerialPortEntry[]> {
  const { binding } = modules ?? (await loadSerial());
  const ports = await binding.list();
  return ports
    .map((port): SerialPortEntry => {
      const label = port.manufacturer?.trim();
      const serialNumber = port.serialNumber?.trim();
      return {
        path: port.path,
        ...(label ? { label } : {}),
        ...(serialNumber ? { serialNumber } : {}),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** What the OS said when a port would not open, as one of the connect error codes. */
export function serialOpenErrorCode(
  message: string,
): 'serial-device-missing' | 'serial-device-busy' | 'serial-permission' {
  if (/permission denied|EACCES|operation not permitted/i.test(message)) return 'serial-permission';
  // Windows says "Access denied" for a port another program holds.
  if (/busy|lock|in use|access denied|temporarily unavailable/i.test(message)) return 'serial-device-busy';
  return 'serial-device-missing';
}

export interface OpenSerialOptions {
  readonly path: string;
  readonly line: SerialLine;
  readonly modules?: SerialModules;
}

/**
 * Opens `path` with the host's line settings. Bytes go in and out unchanged; resize does nothing (a serial
 * line has no window size). The port closing without {@link SshSession.close} (the cable or adapter going
 * away) ends the session as `lost`.
 *
 * @throws WirebenchError `serial-device-missing`, `serial-device-busy` or `serial-permission` when it will
 *   not open, `serial-unavailable` when this platform has no binding
 */
export async function openSerialSession(options: OpenSerialOptions): Promise<SshSession> {
  const { binding, SerialPortStream: Stream } = options.modules ?? (await loadSerial());
  const { line } = options;
  const port = new Stream({
    binding,
    path: options.path,
    baudRate: line.baud,
    dataBits: line.dataBits,
    parity: line.parity,
    stopBits: line.stopBits,
    rtscts: line.flowControl === 'rtscts',
    xon: line.flowControl === 'xonxoff',
    xoff: line.flowControl === 'xonxoff',
    autoOpen: false,
  });
  await new Promise<void>((resolve, reject) => {
    port.open((error) => {
      if (!error) {
        resolve();
        return;
      }
      const code = serialOpenErrorCode(error.message);
      const sentence =
        code === 'serial-permission'
          ? `Wirebench may not open ${options.path}`
          : code === 'serial-device-busy'
            ? `${options.path} is in use by another program`
            : `${options.path} is not on this computer`;
      reject(new WirebenchError(code, sentence, { details: { device: options.path }, cause: error }));
    });
  });

  const dataListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(exit: SessionExit) => void>();
  let closing = false;
  let ended = false;
  port.on('data', (chunk: Buffer) => {
    for (const listener of dataListeners) listener(new Uint8Array(chunk));
  });
  // A failed write or read closes the port with a disconnect error; nothing else needs the error itself.
  port.on('error', () => undefined);
  port.on('close', () => {
    if (ended) return;
    ended = true;
    const exit: SessionExit = { code: null, reason: closing ? 'closed' : 'lost' };
    for (const listener of exitListeners) listener(exit);
  });

  return {
    id: randomUUID(),
    agentForwarding: 'off',
    write(data) {
      if (port.isOpen) port.write(Buffer.from(data));
    },
    resize() {
      // A serial line has no window size.
    },
    close() {
      if (closing || ended) return;
      closing = true;
      if (port.isOpen) port.close();
    },
    exec() {
      return Promise.resolve('');
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
  };
}
