// The `cx` a view gets from the app, for a test.
//
// Spawned work is collected so a test can settle it; timers are recorded, not run, unless the
// test asks for `real` (the rail/spinner cases wait for SLOW with a real clock).
export function fakeCx({ real = false } = {}) {
  const cx = {
    tasks: [],
    timers: [],
    notified: 0,
    notify() { cx.notified++; },
    spawn(fn) { const p = fn(cx); cx.tasks.push(p); return p; },
    focus_handle: () => ({}),
    stop_propagation() {},
    timer: {
      every(ms, fn) { cx.timers.push({ ms, fn, once: false }); if (real) { const id = setInterval(() => fn(cx), ms); id.unref?.(); cx.timers.at(-1).id = id; } return cx.timers.length; },
      after(ms, fn) { cx.timers.push({ ms, fn, once: true }); if (real) setTimeout(() => fn(cx), ms); return cx.timers.length; },
    },
    // Lets every spawned task run; one still pending after a few ms (a loop on nextCommand) is
    // let go rather than hanging the test.
    async settle(budget = 5) {
      while (cx.tasks.length) {
        const p = cx.tasks.shift();
        await Promise.race([p, new Promise((resolve) => setTimeout(resolve, budget))]);
      }
    },
    stopTimers() {
      for (const t of cx.timers) { if (t.id) clearInterval(t.id); }
      cx.timers.length = 0;
    },
  };
  return cx;
}
