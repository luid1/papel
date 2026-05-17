module.exports = {
  apps: [
    {
      name: 'lumin-bot',
      script: 'webhook-handler.js',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '10s',
      exp_backoff_restart_delay: 100,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/bot-error.log',
      out_file:   'logs/bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    },
    {
      name: 'lumin-frontend',
      script: 'server.js',
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 50,
      min_uptime: '5s',
      max_memory_restart: '100M',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/frontend-error.log',
      out_file:   'logs/frontend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
