import { createGate } from './gate';
import type { Gate, Health, Settings } from './types';

export { createGate } from './gate';
export type { Change, Gate, Health, Settings } from './types';

/**
 * The gate this process uses, for the common case of there being one network.
 *
 * **One per process, deliberately.** The thing being watched is the machine's
 * link, so a second gate would be a second opinion about one fact — two probe
 * loops, two windows, and two answers that can disagree. Anything wanting its
 * own — a test, or a caller watching a different route out — builds one with
 * `createGate`.
 *
 * **Configured once, awaited everywhere.** A service settles the numbers at
 * startup, from wherever it keeps such things, and everything after that just
 * calls `pass()`. Nothing downstream has to be handed a gate, and nothing
 * downstream can be configured by accident.
 */
export const configure = (settings: Settings = {}): Gate => {
  shared?.stop();

  return shared = createGate(settings);
};

/**
 * Wait for the network to be worth using.
 *
 * Resolves immediately until something has been configured, so a library or a
 * code path that calls this in a process that never set one up is unaffected.
 */
export const pass = (): Promise<void> => shared?.pass() ?? Promise.resolve();

/** What the shared gate believes, or `open` where there is none. */
export const health = (): Health => shared?.health() ?? 'open';

/** Stop the shared gate's probing, releasing anything held. */
export const stop = (): void => {
  shared?.stop();
  shared = null;
};

let shared: Gate | null = null;
