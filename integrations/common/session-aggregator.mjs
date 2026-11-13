// Host-neutral per-project session aggregation.
//
// State is keyed by [project.key, sessionID]; full identifiers are kept for
// labels, basename only goes to the public project label. Repeated usage
// snapshots contribute nonnegative growth per message; revision increases
// only when aggregates actually change. Sessions and per-session message
// snapshots are bounded with LRU eviction; events for an evicted message
// start a new baseline (documented spec behavior).

export function sessionKey(projectKey, sessionID) {
  return `${projectKey}\u0000${sessionID}`;
}

const ZERO_USAGE = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };

function usageTotal(usage = {}) {
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    reasoning: usage.reasoning || 0,
    cache_read: usage.cache?.read || usage.cacheRead || 0,
    cache_write: usage.cache?.write || usage.cacheWrite || 0,
  };
}

export function createSessionAggregator({ maxSessions = 1000, maxMessages = 1000 } = {}) {
  const sessions = new Map(); // sessionKey -> state
  const revisions = new Map(); // sessionKey -> number
  let epoch = 0; // bumped whenever eviction removes sessions; consumers use it to resync

  function touch(state) {
    sessions.delete(state.key);
    sessions.set(state.key, state);
  }

  function bumpRevision(key) {
    revisions.set(key, (revisions.get(key) || 0) + 1);
  }

  function evictSessions() {
    let evicted = false;
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
      revisions.delete(oldest);
      evicted = true;
    }
    if (evicted) epoch++;
  }

  function ensureState(event, key) {
    let state = sessions.get(key);
    if (!state) {
      state = {
        key,
        sessionLabel: String(event.sessionID),
        projectLabel: event.project.label || event.project.key,
        tokens: {},
        tools: {},
        toolDurationMs: {},
        edits: { added: 0, deleted: 0 },
        permissions: {},
        contextMax: 0,
        startedAt: typeof event.time === "number" ? event.time : 0,
        messages: new Map(),
      };
      sessions.set(key, state);
      bumpRevision(key);
      evictSessions();
    }
    touch(state);
    return state;
  }

  function apply(event) {
    if (!event?.project?.key || !event?.sessionID) return;
    if (event.type === "session.idle") return; // delivery concern, not aggregation
    const key = sessionKey(event.project.key, event.sessionID);

    if (event.type === "tool.finished") {
      if (!event.tool) return;
      const state = ensureState(event, key);
      state.tools[event.tool] = (state.tools[event.tool] || 0) + 1;
      if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs > 0) {
        state.toolDurationMs[event.tool] = (state.toolDurationMs[event.tool] || 0) + event.durationMs;
      }
      bumpRevision(key);
      return;
    }

    if (event.type === "file.edited") {
      // negative or missing components are ignored, never netted against positives
      const added = typeof event.added === "number" && Number.isFinite(event.added) && event.added > 0 ? event.added : 0;
      const deleted = typeof event.deleted === "number" && Number.isFinite(event.deleted) && event.deleted > 0 ? event.deleted : 0;
      if (!added && !deleted) return;
      const state = ensureState(event, key);
      state.edits.added += added;
      state.edits.deleted += deleted;
      bumpRevision(key);
      return;
    }

    if (event.type === "permission.decided") {
      if (event.decision !== "allow" && event.decision !== "deny") return;
      const state = ensureState(event, key);
      state.permissions[event.decision] = (state.permissions[event.decision] || 0) + 1;
      bumpRevision(key);
      return;
    }

    if (event.type !== "message.usage" || !event.messageID) return;
    const state = ensureState(event, key);
    const total = usageTotal(event.usage);
    const seen = state.messages.get(event.messageID) || ZERO_USAGE;
    let changed = false;
    for (const [kind, value] of Object.entries(total)) {
      const growth = Math.max(0, value - (seen[kind] || 0));
      if (growth > 0) {
        state.tokens[kind] = (state.tokens[kind] || 0) + growth;
        changed = true;
      }
    }
    const context = total.input + total.cache_read + total.cache_write;
    if (context > state.contextMax) {
      state.contextMax = context;
      changed = true;
    }
    if (!state.messages.has(event.messageID) || changed) {
      // LRU touch: re-inserting refreshes eviction order for actively
      // streaming messages (Map.set on an existing key does not reorder);
      // stored totals are elementwise maxima so a shrink-then-recover
      // snapshot never counts the recovery as new growth
      const remembered = state.messages.get(event.messageID);
      state.messages.delete(event.messageID);
      const maxima = {};
      for (const [kind, value] of Object.entries(total)) {
        maxima[kind] = Math.max(value, remembered?.[kind] ?? 0);
      }
      state.messages.set(event.messageID, maxima);
      while (state.messages.size > maxMessages) {
        state.messages.delete(state.messages.keys().next().value);
      }
    }
    if (changed) bumpRevision(key);
  }

  function snapshot(project, sessionID, now = Date.now()) {
    if (!project?.key || !sessionID) return null;
    const state = sessions.get(sessionKey(project.key, sessionID));
    if (!state) return null;
    touch(state);
    return {
      tokens: { ...state.tokens },
      tools: { ...state.tools },
      toolDurationMs: { ...state.toolDurationMs },
      edits: { ...state.edits },
      permissions: { ...state.permissions },
      contextMax: state.contextMax,
      durationSeconds: Math.max(0, Math.round((now - state.startedAt) / 1000)),
    };
  }

  function has(key) {
    return sessions.has(key);
  }

  function revision(key) {
    return revisions.get(key) || 0;
  }

  function generation() {
    return epoch;
  }

  return { apply, snapshot, has, revision, generation };
}
