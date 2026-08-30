import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGate } from '../src/gate';
import type { Change, Gate } from '../src/types';

/**
 * The gate's whole job is deciding what a run of probe results means, so the
 * probes themselves are stubbed: `fetch` answers or throws on command, and the
 * clock is driven rather than waited on. Nothing here touches a network.
 */

let gate:    Gate | null = null;
let answers: boolean[]   = [];
let changes: Change[]    = [];

/** One scheduled probe, plus the microtasks its result runs through. */
const tick = async (times = 1) => {
  for (let n = 0; n < times; n++) {
    await vi.advanceTimersByTimeAsync(EVERY);
    await Promise.resolve();
  }
};

const EVERY = 1_000;

const open = (over = {}) => gate = createGate({
  probes:    ['https://probe.invalid/204'],
  everyMs:   EVERY,
  timeoutMs: 100,
  window:    4,
  degradeAt: 2,
  closeAt:   3,
  recoverAt: 2,
  slowByMs:  50,
  onChange:  (change) => { changes.push(change); },
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();

  answers = [];
  changes = [];

  vi.stubGlobal('fetch', vi.fn(async () => {
    if (answers.shift() === false) throw new Error('getaddrinfo ENOTFOUND');

    return { ok: true, status: 204, body: null } as unknown as Response;
  }));
});

afterEach(() => {
  gate?.stop();
  gate = null;

  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Whether `pass()` came back without the clock having to move. */
const passes = async (one: Gate): Promise<boolean> => {
  let done = false;

  void one.pass().then(() => { done = true; });

  await Promise.resolve();
  await Promise.resolve();

  return done;
};

describe('a healthy network', () => {
  it('lets everything through without waiting', async () => {
    answers = [true, true, true];

    const one = open();

    await tick(3);

    expect(one.health()).toBe('open');
    expect(await passes(one)).toBe(true);
    expect(changes).toHaveLength(0);
  });
});

describe('a network that is struggling', () => {
  /**
   * **Slowing down rather than stopping.** Some loss is not an outage, and
   * refusing to make requests over it would be a worse answer than making them
   * more slowly.
   */
  it('holds each caller briefly once loss is enough to notice', async () => {
    answers = [false, true, false, true];

    const one = open();

    await tick(4);

    expect(one.health()).toBe('degraded');

    // It resolves, but not without the clock moving.
    expect(await passes(one)).toBe(false);

    await vi.advanceTimersByTimeAsync(50);

    expect(one.health()).toBe('degraded');
  });
});

describe('a network that is gone', () => {
  it('holds every caller until it comes back', async () => {
    answers = [false, false, false];

    const one = open();

    await tick(3);

    expect(one.health()).toBe('closed');
    expect(await passes(one)).toBe(false);
  });

  /**
   * **Everyone waiting is released together**, by the probe that found the link
   * rather than by anything they did. A caller cannot tell a pause happened.
   */
  it('releases everything held, at once, when the link returns', async () => {
    answers = [false, false, false];

    const one = open();

    await tick(3);

    const waiting = [one.pass(), one.pass(), one.pass()];

    answers = [true, true, true, true];

    await tick(4);

    /**
     * Recovery climbs back through `degraded`, so what was held is released
     * slowed rather than all at once — the delay has to elapse before they
     * settle.
     */
    await vi.advanceTimersByTimeAsync(200);

    await expect(Promise.all(waiting)).resolves.toEqual([undefined, undefined, undefined]);
    expect(one.health()).toBe('open');
  });

  /**
   * **One good probe is not a working network.** Releasing on the first success
   * would send every held request into a link that is still failing, which is
   * how a flapping connection turns into a flapping service.
   */
  it('does not reopen on a single lucky probe', async () => {
    answers = [false, false, false];

    const one = open();

    await tick(3);
    expect(one.health()).toBe('closed');

    answers = [true];

    await tick(1);

    expect(one.health()).toBe('closed');
  });
});

describe('what it reports', () => {
  /**
   * One line's worth of fact per change, and nothing while nothing changes.
   *
   * A link that fails outright is still reported twice on the way down, because
   * it passes through `degraded` on its way to `closed` — the grades are a
   * sequence, not a jump.
   */
  it('says what changed and what it decided on', async () => {
    answers = [false, false, false];

    open();

    await tick(3);

    expect(changes.map(one => [one.from, one.to]))
      .toEqual([['open', 'degraded'], ['degraded', 'closed']]);

    const shut = changes[1]!;

    expect(shut).toMatchObject({ failed: 3 });
    expect(shut.because).toMatch(/ENOTFOUND/);
    expect(shut.window).toEqual([false, false, false]);
  });

  it('says nothing at all while the network is fine', async () => {
    answers = [true, true, true, true];

    open();

    await tick(4);

    expect(changes).toEqual([]);
  });
});

describe('out of the box', () => {
  /**
   * **Nothing to fill in for the expected case.** Settings exist for an
   * application the defaults are wrong for, not as a step in adopting one.
   */
  it('works with no settings at all', async () => {
    answers = [true, true];

    const one = gate = createGate();

    expect(one.health()).toBe('open');
    expect(await passes(one)).toBe(true);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(fetch).toHaveBeenCalled();
    expect(one.health()).toBe('open');
  });

  /** And it watches somewhere that is nobody's dependency in particular. */
  it('probes somewhere by default', async () => {
    answers = [true];

    gate = createGate();

    await vi.advanceTimersByTimeAsync(6_000);

    expect(vi.mocked(fetch).mock.calls[0]![0]).toMatch(/^https:\/\//);
  });

  /**
   * A sample fails only when every probe does, so a list that shares an operator
   * is one probe wearing three hats: the same bad resolver or CDN path fails all
   * of them at once and the gate calls it an outage.
   */
  it('watches more than one operator', async () => {
    /** Every probe has to fail for the whole list to be asked, which is the point. */
    answers = [false, false, false, false, false, false];

    gate = createGate();

    await vi.advanceTimersByTimeAsync(6_000);

    const hosts = vi.mocked(fetch).mock.calls
      .map(call => new URL(String(call[0])).hostname.split('.').slice(-2).join('.'));

    expect(hosts.length).toBeGreaterThan(1);
    expect(new Set(hosts).size).toBeGreaterThan(1);
  });
});

/**
 * **A reply is not an answer.** A captive portal, a proxy asking for credentials
 * and an interception page all cross a network the caller still cannot use, so a
 * gate that counts them as evidence reports a working link into a wall.
 */
describe('what counts as a probe answering', () => {
  const status = (code: number) =>
    vi.mocked(fetch).mockResolvedValue({ ok: code < 300, status: code, body: null } as unknown as Response);

  it('takes a 204 as the answer it is', async () => {
    status(204);

    const one = open();

    await tick(4);

    expect(one.health()).toBe('open');
  });

  it('does not take a portal redirect for a network', async () => {
    status(302);

    const one = open();

    await tick(4);

    expect(one.health()).toBe('closed');
  });

  /** One turned away is not the network, so long as another answers. */
  it('stays open when a probe is turned away and another answers', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
      (String(url).includes('blocked')
        ? { ok: false, status: 403, body: null }
        : { ok: true, status: 200, body: null }) as unknown as Response);

    const one = open({ probes: ['https://blocked.invalid/', 'https://open.invalid/'] });

    await tick(2);

    expect(one.health()).toBe('open');
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('https://open.invalid/');
  });

  /** And says which of them said what, so a log has something to go on. */
  it('reports the status that turned it away', async () => {
    status(403);

    open();

    await tick(4);

    expect(changes.at(-1)?.because).toMatch(/403/);
  });
});

/**
 * **A list asked in turn costs its whole length in the case that matters.** Every
 * probe timing out one after another is the deadline multiplied by however many
 * there are, and that is precisely when the gate most needs to have decided — so
 * a deadline set where it belongs, above what the caller's own traffic costs,
 * would make a sample take the best part of a minute.
 */
describe('asking the probes', () => {
  it('asks them all at once rather than one after another', async () => {
    answers = [true, true, true];

    open({ probes: ['https://one.invalid/', 'https://two.invalid/', 'https://three.invalid/'] });

    await tick(1);

    /** All three in a sample the first probe already answered — which serial would not do. */
    expect(vi.mocked(fetch).mock.calls.map(call => String(call[0]))).toEqual([
      'https://one.invalid/', 'https://two.invalid/', 'https://three.invalid/',
    ]);
  });

  /** And one answering is the whole sample, however the rest end. */
  it('passes on the first probe to answer', async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (! String(url).includes('good')) throw new Error('getaddrinfo ENOTFOUND');

      return { ok: true, status: 204, body: null } as unknown as Response;
    });

    const one = open({ probes: ['https://bad.invalid/', 'https://good.invalid/'] });

    await tick(4);

    expect(one.health()).toBe('open');
    expect(changes).toEqual([]);
  });
});

/**
 * **"fetch failed" is the message for every connection-level failure there is.**
 * DNS, a reset, a connect timeout, a machine out of ephemeral ports — one string
 * for all of them, and the reason on `cause`. Reporting the message alone gives
 * whoever is woken up nothing to act on, and three of those four causes are not
 * the network at all.
 */
describe('saying why a probe failed', () => {
  const throwing = (err: Error) => vi.mocked(fetch).mockRejectedValue(err);

  const wrapped = (code: string, message: string) => {
    const err   = new TypeError('fetch failed');
    const cause = Object.assign(new Error(message), { code });

    err.cause = cause;

    return err;
  };

  it('unwraps the cause rather than reporting the wrapper', async () => {
    throwing(wrapped('ENOTFOUND', 'getaddrinfo ENOTFOUND probe.invalid'));

    open();

    await tick(4);

    expect(changes.at(-1)?.because).toMatch(/ENOTFOUND/);
  });

  /** Which probe, because a list that fails on one host is not a network failing. */
  it('names the host that failed', async () => {
    throwing(wrapped('EADDRNOTAVAIL', 'connect EADDRNOTAVAIL'));

    open();

    await tick(4);

    expect(changes.at(-1)?.because).toMatch(/probe\.invalid/);
  });

  /**
   * All of them, because all of them failing is what a failed sample *is*. One
   * reason reads as one host having a bad minute, which is the one thing it
   * cannot be.
   */
  it('reports every probe, not just the last', async () => {
    /** By host, since every sample asks both and the last change is what is read. */
    vi.mocked(fetch).mockImplementation(async (url) => {
      throw String(url).includes('first')
        ? wrapped('ENOTFOUND', 'getaddrinfo ENOTFOUND')
        : wrapped('ETIMEDOUT', 'connect ETIMEDOUT');
    });

    open({ probes: ['https://first.invalid/', 'https://second.invalid/'] });

    await tick(4);

    const because = changes.at(-1)?.because ?? '';

    expect(because).toMatch(/first\.invalid.*ENOTFOUND/);
    expect(because).toMatch(/second\.invalid.*ETIMEDOUT/);
  });

  /** And nothing at all once they are answering again. */
  it('says nothing when the sample succeeded', async () => {
    answers = [false, false, false, false, true, true, true, true, true, true];

    open();

    await tick(10);

    expect(changes.at(-1)).toMatchObject({ to: 'open' });
    expect(changes.at(-1)?.because).toBeUndefined();
  });

  /** A timeout says so itself, and has no cause to unwrap. */
  it('leaves an error that already explains itself alone', async () => {
    throwing(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

    open();

    await tick(4);

    expect(changes.at(-1)?.because).toMatch(/aborted due to timeout/);
  });
});

describe('a caller that wants none of this', () => {
  /** Taking the dependency must not mean taking the behaviour. */
  it('never shuts when there is nothing to probe', async () => {
    const one = open({ probes: [] });

    answers = [false, false, false, false];

    await tick(4);

    expect(one.health()).toBe('open');
    expect(await passes(one)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops probing and releases whatever it held', async () => {
    answers = [false, false, false];

    const one = open();

    await tick(3);

    const waiting = one.pass();

    one.stop();

    await expect(waiting).resolves.toBeUndefined();
    expect(one.health()).toBe('open');
  });
});
