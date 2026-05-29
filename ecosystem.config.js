// PM2 process config for the PDF microservice.
// Launch from the service root with:   pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "da-pdf-service",
      script: "src/server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "1G",
      out_file: "/var/log/da-pdf-service/out.log",
      error_file: "/var/log/da-pdf-service/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
