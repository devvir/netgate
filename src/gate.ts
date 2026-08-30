import type { Change, Gate, Health, Settings } from './types';

/**
 * A gate every outbound request waits on.
 *
 * **The problem is noise and waste, not correctness.** When a link goes, every
 * request in flight spends its whole retry budget discovering the same fact,
 * says so in the log, and buries whatever was actually happening beforehand. An
 * hour offline is an hour of that, from every worker at once.
 *
 * **It watches the network itself, and takes no reports.** Callers cannot tell
 * it anything — not a failure, not a success — because a caller only ever knows
 * about the host it was talking to, and one host being down is that host's
 * business. What the gate answers is narrower and more useful: is the network
 * worth using at all.
 *
 * **Nothing waiting on it has state to lose.** A caller awaits before it acts,
 * so a pause costs it nothing but time: no attempt is spent, no cursor moves, no
 * retry is consumed. Work resumes exactly where it stopped and cannot tell that
 * anything happened, which is what lets the gate react in seconds without
 * anybody having to be careful.
 */
export const createGate = (settings: Settings = {}): Gate => {
  const at = { ...DEFAULTS, ...settings };

  /** Nothing to probe is a gate that never shuts — see `Settings.probes`. */
  if (at.probes.length === 0) return always();

  /** Newest last. A probe that has not run yet is not evidence either way. */
  const window: boolean[] = [];

  let health: Health         = 'open';
  let shut:   Deferred | null = null;
  let good                   = 0;
  let since                  = Date.now();
  let timer:  ReturnType<typeof setTimeout> | null = null;
  let last:   string | undefined;

  const judge = (): Health => {
    const failed = window.filter(one => ! one).length;

    /**
     * **Quick to stop, slow to trust.** Falling is decided on the window, so a
     * lossy link is caught without waiting for a run of failures it may never
     * produce. Rising needs consecutive successes, because one lucky probe
     * through a link that is still broken would release everything at once.
     */
    if (failed >= at.closeAt)   return 'closed';
    if (health !== 'open' && good < at.recoverAt) return health;
    if (failed >= at.degradeAt) return 'degraded';

    return 'open';
  };

  const settle = (next: Health): void => {
    if (next === health) return;

    const change: Change = {
      from:   health,
      to:     next,
      window: [...window],
      failed: window.filter(one => ! one).length,
      heldMs: Date.now() - since,
      ...(last === undefined ? {} : { because: last }),
    };

    health = next;
    since  = Date.now();

    if (next === 'closed') shut ??= deferred();
    else {
      shut?.resolve();
      shut = null;
    }

    at.onChange?.(change);
  };

  const look = async (): Promise<void> => {
    /**
     * **Every probe's reason, not the last one's.** A sample fails only when all
     * of them do, so reporting one is reporting a third of the evidence — and it
     * reads as a single host having a bad minute, which is the one thing it
     * cannot be. Whether the three failed the same way or three different ways
     * is most of what tells a link apart from this machine.
     */
    const seen: string[] = [];

    const ok = await reaches(at.probes, at.timeoutMs, (err) => { seen.push(err); });

    last = ok ? undefined : seen.join('; ');

    window.push(ok);

    while (window.length > at.window) window.shift();

    good = ok ? good + 1 : 0;

    settle(judge());
  };

  /**
   * **Its own loop, not an interval.** A probe that outlives its period would
   * otherwise overlap with the next one, and a slow network is exactly when that
   * happens — so the next look is scheduled once the last has finished.
   */
  const loop = (): void => {
    timer = setTimeout(() => { void look().finally(loop); }, at.everyMs);

    timer.unref?.();
  };

  loop();

  return {
    pass: async () => {
      if (health === 'open') return;

      while (shut) await shut.promise;

      if (health === 'degraded') await sleep(at.slowByMs);
    },

    health: () => health,

    stop: () => {
      if (timer) clearTimeout(timer);

      timer = null;

      shut?.resolve();
      shut   = null;
      health = 'open';
    },
  };
};

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Endpoints that answer small and answer everywhere, and are not anybody's
 * dependency in particular.
 *
 * **Two operators, because one operator is one probe.** A sample fails only when
 * every one of these does, which is worth nothing if they share a resolver and a
 * CDN path — a bad minute on that path then fails all of them at once and reads
 * as the network being down. Cloudflare first, then Google, so the ordinary
 * sample costs one request to a host the rest of the list does not depend on.
 */
const DEFAULTS = {
  probes:    ['https://www.cloudflare.com/cdn-cgi/trace',
    'https://connectivitycheck.gstatic.com/generate_204',
    'https://www.gstatic.com/generate_204'] as readonly string[],
  everyMs:   5_000,
  timeoutMs: 3_000,
  window:    6,
  degradeAt: 2,
  closeAt:   4,
  slowByMs:  250,
  recoverAt: 3,
  onChange:  undefined as ((change: Change) => void) | undefined,
};

/** A gate with nothing to watch: open, for ever, at no cost. */
const always = (): Gate => ({
  pass:   () => Promise.resolve(),
  health: () => 'open',
  stop:   () => {},
});

/**
 * Whether any of these answer, and answer properly.
 *
 * **A success status, not merely a reply.** These endpoints exist to say the
 * network works and each has exactly one right answer — a 200 with a body of
 * facts, or a 204 with none. Anything else did not come from them: a captive
 * portal, a proxy demanding credentials and an interception page are all replies
 * that crossed a network the caller still cannot use, so counting them as
 * evidence is how a gate reports a working link into a wall.
 *
 * Any 2xx, rather than one status, because the list deliberately mixes shapes
 * and the distinction being drawn is answered-properly against turned-away.
 *
 * Silence, a reset or a timeout is the other half.
 *
 * **All at once, not one after another.** A list asked in turn costs its whole
 * length in the case that matters — every probe timing out in series is the
 * deadline multiplied by however many there are, which is exactly when the gate
 * most needs to have decided. Asked together, a sample costs one round trip
 * however long the list grows, and the deadline can therefore be set where it
 * belongs: above what the *caller's* own traffic costs, so that a busy service
 * is not read as a broken link. The extra requests are two every few seconds
 * against a service issuing hundreds a second.
 *
 * The rest are cancelled the moment one answers, so a success costs the fastest
 * probe rather than the slowest.
 */
const reaches = async (
  probes:  readonly string[],
  timeout: number,
  saw:     (err: string) => void,
): Promise<boolean> => {
  const stop = new AbortController();

  /** By position, so what is reported reads in the order the probes were given. */
  const reasons: string[] = [];

  const ask = async (url: string, at: number): Promise<void> => {
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal:  AbortSignal.any([stop.signal, AbortSignal.timeout(timeout)]),
      });

      await res.body?.cancel();

      if (res.ok) return;

      reasons[at] = `${hostOf(url)} answered ${res.status}`;
    } catch (err) {
      reasons[at] = `${hostOf(url)}: ${why(err)}`;
    }

    /** `Promise.any` settles on the first probe that does *not* do this. */
    throw new Error(reasons[at]);
  };

  try {
    await Promise.any(probes.map(ask));

    return true;
  } catch {
    /**
     * **Only once the whole sample has failed.** A probe that failed while
     * another answered explains nothing — the network worked — and reporting it
     * would name a host having a bad minute as the reason for an outage that
     * did not happen.
     */
    for (const reason of reasons) if (reason !== undefined) saw(reason);

    return false;
  } finally {
    stop.abort();
  }
};

/** The part of a probe URL worth putting in a log line. */
const hostOf = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};

/**
 * What actually went wrong, which is never the message on the error thrown.
 *
 * **`fetch` reports every connection-level failure as the string "fetch
 * failed".** DNS that did not resolve, a socket reset, a connect that timed out,
 * a machine out of ephemeral ports — one message for all of them, with the
 * reason on `cause`. A gate reporting only the message says "the network is
 * failing" and offers nothing to act on, which is worse than saying nothing:
 * every one of those causes points somewhere different, and only one of them is
 * the network.
 *
 * A timeout of this library's own is the exception and needs no unwrapping —
 * `AbortSignal.timeout` throws a `TimeoutError` that says so itself.
 */
const why = (err: unknown): string => {
  if (! (err instanceof Error)) return String(err);

  const cause = err.cause;

  if (! (cause instanceof Error)) return err.message;

  const code = (cause as { code?: unknown }).code;

  return `${err.message}: ${typeof code === 'string' ? code : cause.name} ${cause.message}`;
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;

  const promise = new Promise<void>(done => { resolve = done; });

  return { promise, resolve };
};

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });
