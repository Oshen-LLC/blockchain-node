module.exports = {
  apps: [
    {
      name: "ndts-bridge",
      script: "./dist/index.js",
      cwd: process.env.BRIDGE_CWD || __dirname,
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      out_file: process.env.PM2_OUT_FILE || "/var/log/ndts/bridge-out.log",
      error_file: process.env.PM2_ERROR_FILE || "/var/log/ndts/bridge-error.log",
      time: true,
      env: {
        NODE_ENV: process.env.NODE_ENV || "production",
      },
    },
  ],
};
