import { z } from 'zod';

export type SerialParity = 'none' | 'even' | 'odd' | 'mark' | 'space';
export type SerialFlowControl = 'none' | 'rtscts' | 'xonxoff';
export type SerialDataBits = 5 | 6 | 7 | 8;
export type SerialStopBits = 1 | 1.5 | 2;

/**
 * `ssh.serial` on a host or group (#426): the line settings of a serial console, taken whole from the nearest
 * level that sets it; each field left out is its default. The device it opens is per machine, never here.
 */
export interface SerialSettings {
  baud?: number | undefined;
  dataBits?: SerialDataBits | undefined;
  parity?: SerialParity | undefined;
  stopBits?: SerialStopBits | undefined;
  flowControl?: SerialFlowControl | undefined;
}

/** Every field filled in. */
export type SerialLine = Required<{ [K in keyof SerialSettings]: NonNullable<SerialSettings[K]> }>;

/** 115200 8N1, no flow control: what most consoles of the last twenty years speak. */
export const SERIAL_DEFAULTS: SerialLine = {
  baud: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
};

/** The common rates the form offers; any positive whole number is accepted. */
export const SERIAL_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600] as const;

/** The block with its defaults filled in, per field. */
export function serialLineOf(settings: SerialSettings | undefined): SerialLine {
  return {
    baud: settings?.baud ?? SERIAL_DEFAULTS.baud,
    dataBits: settings?.dataBits ?? SERIAL_DEFAULTS.dataBits,
    parity: settings?.parity ?? SERIAL_DEFAULTS.parity,
    stopBits: settings?.stopBits ?? SERIAL_DEFAULTS.stopBits,
    flowControl: settings?.flowControl ?? SERIAL_DEFAULTS.flowControl,
  };
}

/** `9600 8N1`, `115200 7E2 · RTS/CTS`: the line as consoles are labelled. */
export function serialLineText(line: SerialLine): string {
  const parity = line.parity.charAt(0).toUpperCase();
  const flow = line.flowControl === 'rtscts' ? ' · RTS/CTS' : line.flowControl === 'xonxoff' ? ' · XON/XOFF' : '';
  return `${String(line.baud)} ${String(line.dataBits)}${parity}${String(line.stopBits)}${flow}`;
}

export const serialSchema = z
  .strictObject({
    baud: z.number().int().min(1).max(20_000_000).optional(),
    dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
    parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
    stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
    flowControl: z.enum(['none', 'rtscts', 'xonxoff']).optional(),
  })
  .transform((s): SerialSettings => {
    const out: SerialSettings = {};
    if (s.baud !== undefined) out.baud = s.baud;
    if (s.dataBits !== undefined) out.dataBits = s.dataBits;
    if (s.parity !== undefined) out.parity = s.parity;
    if (s.stopBits !== undefined) out.stopBits = s.stopBits;
    if (s.flowControl !== undefined) out.flowControl = s.flowControl;
    return out;
  })
  .optional();
