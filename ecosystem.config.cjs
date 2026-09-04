// Local/sandbox verification only — mirrors the Render Procfile command.
// Production on Render runs: cd nemesis && gunicorn app:app -c gunicorn.conf.py
module.exports = {
  apps: [{
    name: 'nemesis',
    cwd: '/home/user/webapp/nemesis',
    script: 'gunicorn',
    args: 'app:app -c gunicorn.conf.py',
    interpreter: 'none',
    env: {
      PORT: 3000, FLASK_ENV: 'development',
      SECRET_KEY: 'sandbox-dev-secret-not-for-prod',
      GROQ_MODEL: 'llama-3.3-70b-versatile',
      ADMIN_ENABLED: 'true', ADMIN_TOKEN: 'sandbox-admin', LOG_LEVEL: 'INFO'
    },
    watch: false, instances: 1, exec_mode: 'fork'
  }]
}
