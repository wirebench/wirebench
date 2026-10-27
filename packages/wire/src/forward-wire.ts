import { z } from 'zod';

/**
 * Wire shapes of the SSH area's port forwarding (`forward.*`). No request, answer or event carries a
 * credential, a key's bytes or a forwarded byte: states carry addresses, ports and counts only. Renderer code
 * imports types from here, never a value (the renderer CSP trap; constants live in `ssh-defaults.ts`).
 */

const idSchema = z.string().min(1);
const portSchema = z.number().int().min(1).max(65535);

/** `manual`: started by hand, runs until stopped. `auto`: started with the host's terminals, stops with them. */
export const forwardOriginWireSchema = z.enum(['manual', 'auto']);
export type ForwardOriginWire = z.infer<typeof forwardOriginWireSchema>;

/** `ForwardStatus` of `@wirebench/ssh`, as data. */
export const forwardStatusWireSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('starting') }),
  z.object({
    state: z.literal('running'),
    listening: z.object({ address: z.string(), port: z.number().int() }),
    connections: z.number().int().min(0),
    lastError: z.string().optional(),
  }),
  z.object({ state: z.literal('reconnecting'), attempt: z.number().int(), nextInMs: z.number() }),
  z.object({
    state: z.literal('failed'),
    error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
  }),
  z.object({ state: z.literal('stopped') }),
]);
export type ForwardStatusWire = z.infer<typeof forwardStatusWireSchema>;

export const forwardStateWireSchema = z.object({
  hostId: z.string(),
  ruleId: z.string(),
  origin: forwardOriginWireSchema,
  /** The forwarding group whose Start group started it (by its id); absent for any other start. */
  group: z.string().optional(),
  /** The port it runs on (a one-run override shows here). */
  port: z.number().int(),
  status: forwardStatusWireSchema,
  /** `hosts.yaml` changed the rule since it started: the view offers Restart. */
  changed: z.boolean().optional(),
  /** The rule was removed or switched off since it started: only Stop is offered. */
  removed: z.boolean().optional(),
});
export type ForwardStateWire = z.infer<typeof forwardStateWireSchema>;

export const forwardListRequestSchema = z.strictObject({});
export const forwardListResponseSchema = z.object({ forwards: z.array(forwardStateWireSchema) });
export const forwardStartRequestSchema = z.strictObject({
  hostId: idSchema,
  ruleId: idSchema,
  /** This run only, for "Start on another port…"; the rule keeps its own. */
  port: portSchema.optional(),
  /** The user confirmed a network bind; recorded per machine. */
  confirmBind: z.literal(true).optional(),
  /** Started by this forwarding group's Start group: recorded on the forward's state as where it came from. */
  group: idSchema.optional(),
});
export type ForwardStartRequest = z.infer<typeof forwardStartRequestSchema>;
export const forwardStopRequestSchema = z.strictObject({ hostId: idSchema, ruleId: idSchema });
export type ForwardStopRequest = z.infer<typeof forwardStopRequestSchema>;
export const forwardStopAllRequestSchema = z.strictObject({});
export const forwardFreePortRequestSchema = z.strictObject({ near: portSchema });
export const forwardFreePortResponseSchema = z.object({ port: portSchema });
