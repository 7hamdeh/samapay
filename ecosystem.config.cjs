// NOT REGISTERED WITH PM2. Registering it (and opening the port in nginx) is
// Ibrahim's keystroke — see CLAUDE.md, the four classes. Written now so the
// shape is reviewed with the code rather than invented on deploy day.
module.exports = {
  apps: [{
    name: "samapay",
    // ⚠️ RUN FROM SOURCE VIA tsx, NOT FROM dist/. `tsc` emits the `@/…`
    // path aliases VERBATIM and plain node cannot resolve them —
    // ERR_MODULE_NOT_FOUND on the first import, measured 2026-09-06. The
    // options were a runtime alias loader, rewriting every import to
    // relative, or running the source. THIS BOX ALREADY RUNS THE THIRD:
    // samaprime's smm-poller and webhook-dispatcher are PM2 apps driving
    // tsx. Same pattern, no new machinery, no build step to go stale.
    // (`tsc --noEmit` still gates every commit; tsc-alias + compiled JS is
    // the better long-term shape and is written down rather than done at
    // midnight on the night the service first goes up.)
    // ⚠️ `interpreter`, NOT `script: <the tsx bin>`. node_modules/.bin/tsx is a
    // SHELL SCRIPT (#!/bin/sh); PM2 ran it with `node` and silently dropped
    // the args — the app reported "online" with 0 restarts, empty logs and
    // nothing listening. An "online" process that never started is the worst
    // shape a supervisor can report, so this is written down at the line.
    script: "src/server.ts",
    interpreter: "node_modules/.bin/tsx",
    interpreter_args: "--env-file=.env",
    cwd: "/www/wwwroot/samapay",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "512M",
  }, {
    name: "samapay-worker",
    script: "src/worker/index.ts",
    interpreter: "node_modules/.bin/tsx",
    interpreter_args: "--env-file=.env",
    cwd: "/www/wwwroot/samapay",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "256M",
  }],
};
