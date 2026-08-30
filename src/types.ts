/**
 * What the gate currently believes about the network.
 *
 * **A grade rather than a switch.** A link that is merely struggling is not the
 * same as one that is gone, and the useful response differs: slow down, or stop
 * entirely until it comes back.
 */
export type Health = 'open' | 'degraded' | 'closed';

/** Why the gate changed its mind, for whoever is doing the reporting. */
export interface Change {
  from:    Health;
  to:      Health;

  /** Probe results the decision was made on, newest last. */
  window:  readonly boolean[];

  /** How many of them failed. */
  failed:  number;

  /** How long the gate had been in the state it is leaving. */
  heldMs:  number;

  /**
   * Why the last sample failed — **every probe's reason**, in the order they
   * were asked, since a sample fails only when all of them do.
   *
   * Absent while the probes are answering.
   */
  because?: string;
}

/**
 * How a gate decides, and what it does about it.
 *
 * **Every number is the caller's.** What counts as a struggling network depends
 * on what is being asked of it — a service issuing one request a minute and one
 * issuing a thousand a second do not agree about how much loss is tolerable, and
 * neither of them should have to read this library's mind. Defaults exist to be
 * overridden.
 */
export interface Settings {
  /**
   * Where to look. All of them at once, first to answer wins.
   *
   * **Somewhere that is not what the caller is calling.** The question is
   * whether the network works, not whether one server does — a probe pointed at
   * the same host would close the gate over that host's outage and stop every
   * other request in the process.
   *
   * More than one because an endpoint of its own can have a bad minute; a probe
   * fails only when all of them do. **Which is why they must not share an
   * operator** — a list behind one resolver and one CDN path is a single probe
   * however long it is, and that path's bad minute reads as the network being
   * down. Asked together rather than in turn, so the list can grow without a
   * failing sample growing with it. Empty disables the gate entirely, which is
   * how a service takes the dependency without taking the behaviour.
   *
   * Each must answer **2xx** when the network works. Anything else is a reply
   * from something other than the endpoint asked, and says nothing about whether
   * the caller can reach what it actually wants.
   */
  probes?:     readonly string[];

  /** How often to look, and how long to wait before calling a look a failure. */
  everyMs?:    number;
  timeoutMs?:  number;

  /** How many recent probes are judged on. */
  window?:     number;

  /** Failures within the window that mean *slow down* and *stop*. */
  degradeAt?:  number;
  closeAt?:    number;

  /** What `degraded` costs a caller, per request. */
  slowByMs?:   number;

  /** Consecutive good probes needed before easing back. */
  recoverAt?:  number;

  /**
   * Told whenever the grade changes, and never otherwise.
   *
   * **The library does no logging.** What a change is worth saying, and in what
   * voice, belongs to the application — a library that decided would either pick
   * a logger nobody wanted or invent a format nobody could parse.
   */
  onChange?:   (change: Change) => void;
}

/**
 * A configured gate.
 *
 * **`pass` is the whole interface a caller needs**, and it is deliberately the
 * only thing they can do: awaiting it is passive, so nothing a caller does can
 * influence what the gate believes. What the network is doing is the gate's
 * business, established by its own probing.
 */
export interface Gate {
  /**
   * Wait for the network to be worth using.
   *
   * Returns immediately while open, after a delay while degraded, and not at
   * all while closed — resolving for everyone at once when the link returns.
   */
  pass(): Promise<void>;

  /** What the gate currently believes, for a health endpoint or a status page. */
  health(): Health;

  /** Stop probing. A stopped gate is open, so nothing is left waiting. */
  stop(): void;
}
