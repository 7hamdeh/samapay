// NOT REGISTERED WITH PM2. Registering it (and opening the port in nginx) is
// Ibrahim's keystroke — see CLAUDE.md, the four classes. Written now so the
// shape is reviewed with the code rather than invented on deploy day.
module.exports = {
  apps: [{
    name: "samapay",
    script: "dist/server.js",
    cwd: "/www/wwwroot/samapay",
    node_args: "--env-file=.env",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_memory_restart: "512M",
  }],
};
