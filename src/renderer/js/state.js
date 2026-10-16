// Shared state and a tiny event bus between renderer modules.

export const api = window.xzy;

export const state = {
  workspace: null,      // { root, name }
  settings: null,       // public settings
  models: [],
  info: null,
  gitStatus: null,
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (e) { console.error(`[${event}]`, e); }
  }
}

/** Commands for palette, menu and keybindings. */
export const commands = new Map();
export function command(id, label, run, key = '') {
  commands.set(id, { id, label, run, key });
}
export function runCommand(id, ...args) {
  const c = commands.get(id);
  if (c) return c.run(...args);
  console.warn('unknown command', id);
  return undefined;
}
