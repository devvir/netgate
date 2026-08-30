# netgate

A gate every outbound request waits on, so a failing network costs a pause
instead of a flood of retries.

When a link goes down, every request in flight spends its whole retry budget
discovering the same fact, logs it, and buries whatever was happening
beforehand. An hour offline is an hour of that, from every worker at once.
`netgate` makes the network's state one fact, established once, that everything
waits on.

## Install

```sh
npm install @devvir/netgate
```

## Use

Turn it on once, where an application settles its other startup decisions:

```ts
import { configure } from '@devvir/netgate';

configure();
```

Then wait on it wherever requests are made:

```ts
import { pass } from '@devvir/netgate';

await pass();

const res = await fetch(url);
```

That is the whole integration. Nothing needs to be handed a gate, and nothing
downstream can be configured by accident.

**The defaults are the expected case.** They watch Cloudflare's `cdn-cgi/trace`
and two public `generate_204` endpoints every five seconds, and are tuned to hold
in seconds rather than minutes; an application that wants the ordinary behaviour
passes nothing. Two operators rather than one, because a sample fails only when
every probe does — a list sharing a resolver and a CDN path is one probe wearing
several hats. They are asked **together**, so a sample costs one round trip
however long the list is and however high the deadline is set; asked in turn, a
total outage would cost the deadline times the length of the list, at the moment
the gate most needs to have decided. A probe counts as answering on a **2xx** and
on nothing else: a
captive portal, a proxy demanding credentials and an interception page all reply
across a network the caller still cannot use. The
one thing worth adding early is somewhere for it to report:

```ts
configure({
  onChange: ({ from, to, failed, window, because }) =>
    log.warn({ from, to, failed, probes: window.length, because }, 'Network state changed'),
});
```

Everything below exists for when the defaults are wrong for a particular
application, not as a step in setting one up.

## What it does

The gate probes the network on its own timer and grades what it finds:

| state | `pass()` |
|---|---|
| `open` | returns immediately |
| `degraded` | returns after `slowByMs` — throttling, not stopping |
| `closed` | does not return until the link comes back |

**Falling is judged on a window, rising on a streak.** A lossy link is caught
without waiting for consecutive failures it may never produce, while recovery
needs `recoverAt` good probes in a row — one lucky probe should not release
everything into a link that is still broken. Recovery climbs back through
`degraded`, so what was held is released throttled rather than all at once.

## What it does not do

**It takes no reports from callers.** A caller only knows about the host it was
talking to, and one host being down is that host's business — its own retries
and limits are the right answer to it. The gate answers something narrower: is
the network worth using at all.

**It does not log.** What a change is worth saying, and in what voice, belongs
to the application. `onChange` hands over the facts.

**It reads no environment.** Every number is an argument. An application that
takes its settings from the environment does so itself and passes them in.

**Nothing waiting on it has state to lose.** A caller waits before it acts, so a
pause costs it nothing but time: no attempt spent, no cursor moved, no retry
consumed. Work resumes where it stopped and cannot tell that anything happened.

## Settings

| setting | default | |
|---|---|---|
| `probes` | Cloudflare's `cdn-cgi/trace`, two `generate_204` endpoints | where to look. All at once, first 2xx wins. Empty disables the gate entirely |
| `everyMs` | `5000` | how often |
| `timeoutMs` | `3000` | how long a probe may take before it counts as failed |
| `window` | `6` | how many recent probes are judged on |
| `degradeAt` | `2` | failures in the window that mean *slow down* |
| `closeAt` | `4` | failures in the window that mean *stop* |
| `slowByMs` | `250` | what `degraded` costs each caller |
| `recoverAt` | `3` | consecutive good probes before easing back |
| `onChange` | — | called on every grade change, and never otherwise |

Point `probes` at something that is not what the application is calling. A probe
aimed at the same host would close the gate over that host's outage and stop
every unrelated request with it.

`createGate(settings)` builds an independent gate for anything that needs one —
a test, or a process watching more than one route out.

## Licence

ISC
