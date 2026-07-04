// Polyfills the window.storage API (get/set/delete/list) that Claude.ai
// artifacts get for free, using the browser's localStorage instead.
// This lets the journal's persistence code run unmodified once deployed
// as a normal static site (e.g. on Render).
//
// NOTE: localStorage is per-browser, per-device. If you open the journal
// on your phone and your laptop, they will NOT share trades. If you need
// cross-device sync, you'd want a small backend + database instead.

function nsKey(key, shared) {
  return `${shared ? "shared" : "user"}::${key}`;
}

if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key, shared = false) {
      const raw = window.localStorage.getItem(nsKey(key, shared));
      if (raw === null) return null;
      return { key, value: raw, shared: !!shared };
    },
    async set(key, value, shared = false) {
      window.localStorage.setItem(nsKey(key, shared), value);
      return { key, value, shared: !!shared };
    },
    async delete(key, shared = false) {
      const existed = window.localStorage.getItem(nsKey(key, shared)) !== null;
      window.localStorage.removeItem(nsKey(key, shared));
      return { key, deleted: existed, shared: !!shared };
    },
    async list(prefix = "", shared = false) {
      const ns = shared ? "shared::" : "user::";
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const full = window.localStorage.key(i);
        if (full && full.startsWith(ns)) {
          const bare = full.slice(ns.length);
          if (bare.startsWith(prefix)) keys.push(bare);
        }
      }
      return { keys, prefix, shared: !!shared };
    },
  };
}
