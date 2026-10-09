const fs = require('fs')
const path = require('path')

// Minimal .env loader (KEY=value lines), so we don't need dotenv on Node 18.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m || process.env[m[1]] !== undefined) continue
    const quoted = m[2].match(/^(['"])(.*)\1$/)
    // Unquoted values can have a trailing " # comment".
    process.env[m[1]] = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '')
  }
}

// Tests set TICKETS_NO_DOTENV so a local .env can't change their behaviour.
if (!process.env.TICKETS_NO_DOTENV) loadEnvFile(path.join(__dirname, '..', '.env'))

const env = process.env
const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'))

const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  production: env.NODE_ENV === 'production',
  trustProxy: env.TRUST_PROXY === '1',
  sessionSecret: env.SESSION_SECRET || '',
  sessionHours: Number(env.SESSION_HOURS || 24 * 7),
  timezone: env.TZ_ISSUES || 'Europe/Madrid',
  dataDir,
  issuesDir: path.join(dataDir, 'issues'),
  uploadsDir: path.join(dataDir, 'uploads'),
  tmpDir: path.join(dataDir, 'tmp'),
  usersFile: path.join(dataDir, 'users.json'),
  issueIdStart: Number(env.ISSUE_ID_START || 1),
  projects: (env.PROJECTS || 'projectes-front, projectes-v5').split(',').map((s) => s.trim()).filter(Boolean),
  upload: {
    maxFileMb: Number(env.UPLOAD_MAX_MB || 10),
    maxFiles: Number(env.UPLOAD_MAX_FILES || 8),
  },
  // Base URL used in email links, e.g. https://tiquets.example.org
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === '1', // 1 for port 465 (implicit TLS); 587 uses STARTTLS
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || '',
  },
  ai: {
    apiKey: env.ZAI_API_KEY || '',
    baseUrl: (env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4').replace(/\/$/, ''),
    model: env.ZAI_MODEL || 'glm-5.1',
    visionModel: env.ZAI_VISION_MODEL || '',
    timeoutMs: Number(env.ZAI_TIMEOUT_MS || 90000),
  },
}

module.exports = config
