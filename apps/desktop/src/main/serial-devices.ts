import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { WirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';

export const SERIAL_DEVICES_FILE = 'serial-devices.json';

/** A device path is a name the OS gives a port: never empty, never a line break (it is part of no key). */
const devicePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .regex(/^[^\r\n\0]+$/);

const devicesFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), devicePathSchema),
});

type DevicesFile = z.infer<typeof devicesFileSchema>;

const empty = (): DevicesFile => ({ version: 1, devices: {} });

/** `<workspace id>\n<host id>`: a line break is in neither. */
const keyOf = (workspaceId: string, hostId: string): string => `${workspaceId}\n${hostId}`;

/**
 * The device each serial host opens on this machine (#426), in `userData/serial-devices.json`, keyed by the
 * workspace and the host. It never reaches `hosts.yaml`, sync or a team: the same console is `COM3` on one
 * computer and `/dev/ttyUSB0` on the next. Writes are atomic and go one at a time, each reading the file
 * afresh. A missing file is an empty store; a malformed one reads empty, is reported once, and is left on
 * disk until the next save replaces it.
 */
export class SerialDeviceStore {
  private queue: Promise<unknown> = Promise.resolve();
  private reported = false;

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = console.warn,
  ) {}

  get(workspaceId: string, hostId: string): Promise<string | undefined> {
    return this.enqueue(async () => (await this.read()).devices[keyOf(workspaceId, hostId)]);
  }

  /**
   * `null` forgets the host's device, so the next connect asks again.
   * @throws WirebenchError `serial-device-invalid` for an empty path or one with a line break
   */
  set(workspaceId: string, hostId: string, device: string | null): Promise<void> {
    let path: string | undefined;
    if (device !== null) {
      const parsed = devicePathSchema.safeParse(device);
      if (!parsed.success) {
        return Promise.reject(
          new WirebenchError('serial-device-invalid', 'Name the serial device, like COM3 or /dev/ttyUSB0'),
        );
      }
      path = parsed.data;
    }
    return this.enqueue(async () => {
      const devices = { ...(await this.read()).devices };
      const key = keyOf(workspaceId, hostId);
      if (path === undefined) delete devices[key];
      else devices[key] = path;
      await mkdir(dirname(this.file), { recursive: true });
      await writeFileAtomic(nodeFs, this.file, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`);
    });
  }

  private async read(): Promise<DevicesFile> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return empty();
    }
    try {
      return devicesFileSchema.parse(JSON.parse(text));
    } catch {
      if (!this.reported) {
        this.reported = true;
        this.log(
          `[wirebench] ${this.file} is malformed; serial hosts ask for their device until the next save replaces it.`,
        );
      }
      return empty();
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
