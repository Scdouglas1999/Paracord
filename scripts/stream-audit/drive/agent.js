// In-page agent for the stream audit (test tooling, never shipped): learns its
// role from the app's HOME (".../<role>.home"), long-polls same-origin
// /__drive/next?role=<role>, imports each command module and posts the result.

// Keep console lines for the driver (the app's own log carries the rest).
if (!window.__logs) {
  window.__logs = [];
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    const o = console[k].bind(console);
    console[k] = (...a) => {
      try {
        window.__logs.push([Date.now(), k, a.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x)?.slice(0, 300) : String(x))).join(' ')]);
        if (window.__logs.length > 3000) window.__logs.splice(0, 1000);
      } catch { /* never break the app */ }
      o(...a);
    };
  }
}

// Remember media owner ids passed over IPC, so the driver can call
// media_get_stream_diagnostics for the live call.
try {
  const internals = window.__TAURI_INTERNALS__;
  if (internals && !internals.__auditTapped) {
    const state = { owners: new Set() };
    window.__auditIpc = state;
    const original = internals.invoke.bind(internals);
    internals.invoke = function (cmd, args, options) {
      try { if (args && typeof args.ownerId === 'string') state.owners.add(args.ownerId); } catch { /* tooling */ }
      return original(cmd, args, options);
    };
    internals.__auditTapped = true;
  }
} catch { /* tooling only */ }

function safe(value) {
  try { return JSON.parse(JSON.stringify(value ?? null)); } catch { return String(value); }
}

async function whoAmI() {
  try {
    // BaseDirectory.Home = 21 (tauri v2 path plugin).
    const home = await window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 21 });
    const m = /([a-z0-9-]+)\.home\/?$/.exec(String(home));
    if (m) return m[1];
  } catch { /* not the desktop app */ }
  return 'default';
}

async function loop() {
  const role = await whoAmI();
  window.__auditRole = role;
  for (;;) {
    let job = null;
    try {
      const response = await fetch(`/__drive/next?role=${encodeURIComponent(role)}`, { cache: 'no-store' });
      if (response.status === 200) job = await response.json();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!job) continue;
    let result = null;
    let error = null;
    try {
      const mod = await import(job.url);
      result = await mod.default();
    } catch (err) {
      error = String(err && err.message ? `${err.name}: ${err.message} @ ${err.stack}` : err);
    }
    try {
      await fetch('/__drive/result', { method: 'POST', body: JSON.stringify({ id: job.id, result: safe(result), error }) });
    } catch { /* the page is going away */ }
  }
}
loop();
