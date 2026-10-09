const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const multer = require('multer')
const { Marked } = require('marked')
const config = require('./lib/config')
const users = require('./lib/users')
const issues = require('./lib/issues')
const ai = require('./lib/ai')
const translations = require('./lib/translations')
const mailer = require('./lib/mailer')
const sso = require('./lib/sso')
const tenants = require('./lib/tenants')
const { setSession, clearSession, sessionMiddleware } = require('./lib/session')

if (config.ssoKey && config.ssoKey.length < 32) {
  console.error('TICKETS_SSO_KEY must have 32+ chars. Generate one with: openssl rand -base64 48')
  process.exit(1)
}

if (!config.sessionSecret || config.sessionSecret.length < 32) {
  console.error('SESSION_SECRET must be set (32+ chars). Generate one with: openssl rand -hex 32')
  process.exit(1)
}

for (const dir of [config.issuesDir, config.uploadsDir, config.translationsDir, config.tmpDir]) fs.mkdirSync(dir, { recursive: true })

// --- Markdown: raw HTML is escaped, only safe links, no remote images ---------
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const safeHref = (href) => (/^(https?:|mailto:|#)/i.test(href || '') ? href : null)
const markdown = new Marked({
  renderer: {
    html({ text }) { return escapeHtml(text) },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      const safe = safeHref(href)
      return safe ? `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>` : label
    },
    image({ text }) { return escapeHtml(text) },
  },
})

// --- Uploads -------------------------------------------------------------------
const ALLOWED_UPLOADS = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
}
const extOf = (name) => path.extname(String(name || '')).toLowerCase()

const upload = multer({
  storage: multer.diskStorage({
    destination: config.tmpDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: config.upload.maxFileMb * 1024 * 1024, files: config.upload.maxFiles, fields: 5, fieldSize: 100 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOADS[extOf(file.originalname)]) return cb(null, true)
    cb(Object.assign(new Error(`File type not allowed: ${file.originalname}`), { status: 400 }))
  },
})

function cleanupTmp(files) {
  for (const f of files || []) fs.rm(f.path, { force: true }, () => {})
}

// Keeps the original name for display only; never used as a path.
function displayName(name) {
  // multer decodes names as latin1
  const utf8 = Buffer.from(name, 'latin1').toString('utf8')
  return utf8.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 120)
}

// --- Login rate limiting (in memory) ------------------------------------------
const failures = new Map()
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 8

const SSO_MAX_FAILURES = 30 // per IP; several users may share an office IP

function loginBlocked(key, max = LOGIN_MAX_FAILURES) {
  const entry = failures.get(key)
  if (!entry || entry.until < Date.now()) { failures.delete(key); return false }
  return entry.count >= max
}

function loginFailed(key) {
  const entry = failures.get(key)
  if (!entry || entry.until < Date.now()) failures.set(key, { count: 1, until: Date.now() + LOGIN_WINDOW_MS })
  else entry.count++
}

// --- App -----------------------------------------------------------------------
const app = express()
app.disable('x-powered-by')
if (config.trustProxy) app.set('trust proxy', 1)

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }))
app.use('/api', express.json({ limit: '20kb' }))
app.use('/api', sessionMiddleware)

// CSRF: the session cookie is SameSite=Strict, and every state-changing request
// must come from our own JS (custom header + same Origin when the browser sends it).
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method)) return next()
  const origin = req.headers.origin
  let sameOrigin = true
  if (origin) { try { sameOrigin = new URL(origin).host === req.headers.host } catch { sameOrigin = false } }
  if (req.headers['x-requested-with'] !== 'tickets' || !sameOrigin) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  next()
})
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })

const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not logged in' }))
const isAdmin = (user) => user.role === 'admin'
// Public tickets can be read by every user; only the author or an admin can change one.
const canEdit = (user, issue) => isAdmin(user) || issue.author === user.username
const canSee = (user, issue) => canEdit(user, issue) || issue.public === true

function withAuthorName(issue) {
  const author = users.find(issue.author)
  return { ...issue, authorName: author ? author.name : issue.author }
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {}
  const key = `${req.ip}|${String(username || '').toLowerCase()}`
  if (loginBlocked(key)) return res.status(429).json({ error: 'Too many attempts. Try again later.' })
  const user = users.authenticate(username, password)
  if (!user) {
    loginFailed(key)
    return res.status(401).json({ error: 'Wrong username or password' })
  }
  failures.delete(key)
  setSession(res, user)
  res.json({ user: users.publicUser(user) })
})

// SSO from an ESSTRAPIS instance: /sso?token=<encrypted token> (see lib/sso.js)
const ssoFailedPage = `<!doctype html><html lang="ca"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accés no vàlid</title><link rel="stylesheet" href="/style.css"><main><section class="card narrow"><h1>Enllaç d'accés no vàlid</h1><p class="muted">L'enllaç ha caducat o ja s'ha fet servir. Torna-hi des d'ESSTRAPIS o entra amb el teu usuari.</p><p><a href="/">Ves a l'inici</a></p></section></main></html>`

app.get('/sso', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const fail = (reason) => {
    console.warn(`[sso] rejected (${req.ip}): ${reason}`)
    loginFailed(`sso|${req.ip}`)
    res.status(401).type('html').send(ssoFailedPage)
  }
  if (loginBlocked(`sso|${req.ip}`, SSO_MAX_FAILURES)) return res.status(429).type('html').send(ssoFailedPage)
  if (!config.ssoKey) return fail('SSO is off (no TICKETS_SSO_KEY)')
  let payload
  let user
  try {
    payload = sso.readToken({ secret: config.ssoKey, token: req.query.token })
    if (!sso.consumeNonce(payload.nonce, payload.exp)) throw new Error('token already used')
    if (!tenants.seen(payload.tenant, payload.tenantName)) throw new Error(`tenant ${payload.tenant} is disabled`)
    user = users.ssoLogin({ email: payload.email, name: payload.name, tenant: payload.tenant })
  } catch (err) {
    return fail(err.message)
  }
  setSession(res, user)
  // Redirect so the token leaves the address bar and history.
  res.redirect(303, '/#/')
})

app.post('/api/logout', (req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: users.publicUser(req.user), statuses: issues.STATUSES, closed: issues.CLOSED, upload: { ...config.upload, extensions: Object.keys(ALLOWED_UPLOADS) } })
})

app.get('/api/issues', requireUser, (req, res) => {
  const list = issues.list().filter((i) => canSee(req.user, i)).map((i) => ({ ...withAuthorName(i), title: translations.title(i) }))
  res.json({ issues: list })
})

// Shown in Catalan; the file stays in English. Admins also get the English original.
app.get('/api/issues/:id', requireUser, async (req, res) => {
  const issue = issues.get(req.params.id)
  if (!issue || !canSee(req.user, issue)) return res.status(404).json({ error: 'Not found' })
  const ca = await translations.ensure(issue, config.ai.translateWaitMs)
  const { body, ...rest } = issue
  res.json({
    issue: {
      ...withAuthorName(rest),
      title: ca.title,
      canEdit: canEdit(req.user, issue),
      html: markdown.parse(ca.body),
      translated: ca.translated,
      ...(ca.translated && isAdmin(req.user) ? { original: { title: issue.title, html: markdown.parse(body) } } : {}),
    },
  })
})

// The same issue with its Catalan title, for the emails.
const inCatalan = (issue, ca) => issue && ca && { ...issue, title: ca.title }

// Caps AI calls per user (new tickets + follow-ups), so a leaked account can't burn the z.ai quota.
const created = new Map()
const MAX_ISSUES_PER_HOUR = 30
function creationAllowed(req, res, next) {
  const recent = (created.get(req.user.username) || []).filter((t) => t > Date.now() - 3600 * 1000)
  if (recent.length >= MAX_ISSUES_PER_HOUR) return res.status(429).json({ error: 'Too many AI requests in the last hour. Try again later.' })
  created.set(req.user.username, [...recent, Date.now()])
  next()
}

function readText(req) {
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : ''
  if (text.length < 2 || text.length > 20000) throw Object.assign(new Error('Write between 2 and 20000 characters'), { status: 400 })
  return text
}

function describeFiles(files) {
  return files.map((f) => ({
    file: `${crypto.randomBytes(12).toString('hex')}${extOf(f.originalname)}`,
    name: displayName(f.originalname),
    size: f.size,
  }))
}

function storeFiles(id, files, attachments) {
  const dir = path.join(config.uploadsDir, id)
  fs.mkdirSync(dir, { recursive: true })
  files.forEach((f, i) => fs.renameSync(f.path, path.join(dir, attachments[i].file)))
}

app.post('/api/issues', requireUser, creationAllowed, upload.array('files'), async (req, res) => {
  const files = req.files || []
  try {
    const text = readText(req)
    if (text.length < 10) return res.status(400).json({ error: 'Write at least 10 characters' })
    const draft = await ai.draftIssue(text, files)
    const attachments = describeFiles(files)
    const isPublic = req.body.public === 'true'
    const id = await issues.create({ draft, originalText: text, author: req.user, attachments, isPublic })
    storeFiles(id, files, attachments)
    res.status(201).json({ id, ai: draft.ai })
    const issue = issues.get(id)
    translations.ensure(issue).then((ca) => mailer.created(inCatalan(issue, ca), req.user))
  } finally {
    cleanupTmp(files)
  }
})

// Follow-up: the user adds information; the AI rewrites the ticket and replies.
app.post('/api/issues/:id/messages', requireUser, creationAllowed, upload.array('files'), async (req, res) => {
  const files = req.files || []
  try {
    const issue = issues.get(req.params.id)
    if (!issue || !canSee(req.user, issue)) return res.status(404).json({ error: 'Not found' })
    if (!canEdit(req.user, issue)) return res.status(403).json({ error: 'Only the author or an admin can change this ticket' })
    const text = readText(req)
    const current = `Type: ${issue.type} · Priority: ${issue.priority} · Project: ${issue.project || '-'}\n\n${issue.body}`
    const { draft, reply } = await ai.reviseIssue(current, text, files)
    const attachments = describeFiles(files)
    const updated = await issues.addFollowUp(issue.id, { draft, message: text, reply, author: req.user, attachments })
    storeFiles(issue.id, files, attachments)
    res.status(201).json({ ai: Boolean(draft), reply })
    translations.ensure(updated).then((ca) => mailer.followUp(inCatalan(updated, ca), req.user, text, reply))
  } finally {
    cleanupTmp(files)
  }
})

app.patch('/api/issues/:id', requireUser, async (req, res) => {
  const issue = issues.get(req.params.id)
  if (!issue || !canSee(req.user, issue)) return res.status(404).json({ error: 'Not found' })
  if (!canEdit(req.user, issue)) return res.status(403).json({ error: 'Only the author or an admin can change this ticket' })
  const { status, public: isPublic } = req.body || {}
  if (status !== undefined && !issues.STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' })
  if (isPublic !== undefined && typeof isPublic !== 'boolean') return res.status(400).json({ error: 'Invalid visibility' })
  if (status === undefined && isPublic === undefined) return res.status(400).json({ error: 'Nothing to change' })
  const updated = await issues.update(issue.id, { status, public: isPublic }, req.user)
  res.json({ ok: true })
  mailer.changed(inCatalan(issue, translations.cached(issue)), inCatalan(updated, translations.cached(updated)), req.user)
})

app.get('/api/issues/:id/files/:file', requireUser, (req, res) => {
  const issue = issues.get(req.params.id)
  if (!issue || !canSee(req.user, issue)) return res.status(404).end()
  const att = issue.attachments.find((a) => a.file === req.params.file)
  if (!att || !/^[a-f0-9]{24}\.[a-z0-9]+$/.test(att.file)) return res.status(404).end()
  const type = ALLOWED_UPLOADS[extOf(att.file)] || 'application/octet-stream'
  const inline = type.startsWith('image/') || type === 'application/pdf'
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.name)}`)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.sendFile(path.join(config.uploadsDir, issue.id, att.file), (err) => { if (err && !res.headersSent) res.status(404).end() })
})

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload error: ${err.message}` })
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message })
  console.error(err)
  res.status(500).json({ error: 'Internal error' })
})

if (require.main === module) {
  app.listen(config.port, config.host, () => {
    console.log(`Tickets listening on http://${config.host}:${config.port}`)
    if (!mailer.enabled()) console.log('Email notifications off (no SMTP_HOST)')
    else mailer.ready().then((ok) => ok && console.log(`Email notifications on (SMTP ${config.smtp.host} verified)`))
  })
}

module.exports = app
