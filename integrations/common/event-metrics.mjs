// Revision-based delivery over the session aggregator: one active HTTP
// request per session, exactly one trailing request when the rendered
// revision went stale, a 15s throttle with a single trailing timer, and an
// idle flush that bypasses the throttle only for dirty sessions. dispose()
// quiesces: timers cancelled, every dirty session gets one final attempt,
// and no timer or network work survives an awaited dispose.

import { sessionKey } from "./session-aggregator.mjs";
import { renderPrometheus } from "./prometheus.mjs";

const THROTTLE_MS = 15000;

const defaultScheduler = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.(); // a pending trailing push must not keep a CLI alive
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  },
};

export function createEventMetrics({
  config,
  client,
  aggregator,
  clock = { now: () => Date.now() },
  scheduler = defaultScheduler,
  maxSessions = 1000,
} = {}) {
  const sessions = new Map(); // sessionKey -> { project, sessionID, projectLabel, active, renderedRevision, deliveredRevision, lastPushAt, timer }
  const inFlight = new Set();
  let disposed = false;

  function stateFor(event) {
    const key = sessionKey(event.project.key, event.sessionID);
    let state = sessions.get(key);
    if (!state) {
      state = {
        key,
        project: event.project,
        sessionID: String(event.sessionID),
        projectLabel: event.project.label || event.project.key,
        active: false,
        renderedRevision: 0,
        deliveredRevision: 0,
        epoch: aggregator.generation ? aggregator.generation() : 0,
        lastPushAt: -THROTTLE_MS, // first delivery is never throttled
        timer: null,
      };
      sessions.set(key, state);
      evictDeliveryState();
    }
    // LRU touch
    sessions.delete(key);
    sessions.set(key, state);
    return state;
  }

  function evictDeliveryState() {
    if (sessions.size <= maxSessions) return;
    for (const [key, state] of sessions) {
      if (sessions.size <= maxSessions) break;
      if (state.active || state.timer) continue; // never drop live delivery work
      sessions.delete(key);
    }
  }

  // aggregator eviction restarts a session's revisions; a value comparison
  // alone cannot detect it (new epoch revisions collide with delivered ones),
  // so resync on the aggregator's eviction epoch
  function currentRevision(state) {
    const epoch = aggregator.generation ? aggregator.generation() : 0;
    if (epoch !== state.epoch) {
      state.epoch = epoch;
      state.deliveredRevision = 0;
    }
    return aggregator.revision(state.key);
  }

  async function push(state, { final = false } = {}) {
    if (state.active || (disposed && !final)) return;
    state.active = true; // synchronous guard, set before any await
    const renderedRevision = currentRevision(state);
    state.renderedRevision = renderedRevision;
    const delivery = (async () => {
      const snapshot = aggregator.snapshot(state.project, state.sessionID, clock.now());
      if (snapshot) {
        const labels = {
          ...config.labels,
          runtime: config.runtime,
          session: state.sessionID,
          project: state.projectLabel,
        };
        const body = renderPrometheus({
          labels,
          tokens: snapshot.tokens,
          tools: snapshot.tools,
          toolDurationMs: snapshot.toolDurationMs,
          edits: snapshot.edits,
          permissions: snapshot.permissions,
          contextMax: snapshot.contextMax,
          durationSeconds: snapshot.durationSeconds,
        });
        const delivered = await client.push({ labels, body });
        if (delivered) state.deliveredRevision = renderedRevision;
      }
    })();
    const tracked = delivery.finally(() => {
      state.active = false;
      inFlight.delete(tracked);
      // one trailing request when the rendered revision went stale mid-flight
      if (!disposed && currentRevision(state) > renderedRevision) {
        scheduleTimer(state, 0);
      }
    });
    inFlight.add(tracked);
    await tracked;
  }

  function scheduleTimer(state, wait) {
    if (state.timer) return;
    state.timer = scheduler.setTimeout(() => {
      state.timer = null;
      state.lastPushAt = clock.now();
      push(state);
    }, wait);
  }

  function handle(event) {
    aggregator.apply(event);
    if (disposed || !config.enabled) return;
    if (!event?.project?.key || !event?.sessionID) return;
    if (event.type === "session.idle") return;
    const state = stateFor(event);
    if (currentRevision(state) <= state.deliveredRevision) return;
    if (state.active) return; // trailing delivery covers the newer revision
    const wait = state.lastPushAt + THROTTLE_MS - clock.now();
    if (wait <= 0) {
      state.lastPushAt = clock.now();
      push(state);
      return;
    }
    scheduleTimer(state, wait);
  }

  async function flush({ project, sessionID }) {
    if (disposed || !project?.key || !sessionID) return;
    const state = sessions.get(sessionKey(project.key, sessionID));
    if (!state || state.active) return;
    if (currentRevision(state) <= state.deliveredRevision) return;
    if (state.timer) {
      scheduler.clearTimeout(state.timer);
      state.timer = null;
    }
    state.lastPushAt = clock.now();
    await push(state);
  }

  async function dispose() {
    disposed = true;
    for (let safety = 0; safety < 10; safety++) {
      for (const state of sessions.values()) {
        if (state.timer) {
          scheduler.clearTimeout(state.timer);
          state.timer = null;
        }
      }
      const dirty = [...sessions.values()].filter(
        (state) => !state.active && currentRevision(state) > state.deliveredRevision,
      );
      const finals = dirty.map((state) => {
        // one failed final attempt is not retried
        state.deliveredRevision = aggregator.revision(state.key);
        return push(state, { final: true });
      });
      const pending = [...inFlight];
      if (!finals.length && !pending.length) break;
      await Promise.allSettled([...finals, ...pending]);
    }
  }

  return { handle, flush, dispose };
}
