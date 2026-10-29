/** The agent's first port (hosted edition spec §18.3). */
export const AGENT_FIRST_PORT = 47_615;
/** The last port it tries before giving up. */
export const AGENT_LAST_PORT = 47_634;

/** The ports the agent tries, in order: 47615, then the next free one up to 47634. */
export const AGENT_PORTS: readonly number[] = Array.from(
  { length: AGENT_LAST_PORT - AGENT_FIRST_PORT + 1 },
  (_, index) => AGENT_FIRST_PORT + index,
);
