const { describe, test, before, after } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-test-'))
process.env.TICKETS_NO_DOTENV = '1'
process.env.DATA_DIR = dataDir
process.env.SESSION_SECRET = 'x'.repeat(40)
process.env.ZAI_API_KEY = 'test-key'

let aiReply = null
let aiRequest = null
const fakeAi = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    aiRequest = { headers: req.headers, body: JSON.parse(body) }
    if (!aiReply) { res.writeHead(500); return res.end('boom') }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: aiReply } }] }))
  })
})

describe('tickets app', () => {
  let server, base
  before(async () => {
    await new Promise((r) => fakeAi.listen(0, '127.0.0.1', r))
    process.env.ZAI_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}`
    const users = require('../lib/users')
    users.upsert({ username: 'anna', name: 'Anna', role: 'user', password: 'anna-password-1' })
    users.upsert({ username: 'pere', name: 'Pere', role: 'user', password: 'pere-password-1' })
    users.upsert({ username: 'admin', name: 'Admin', role: 'admin', password: 'admin-password-1' })
    const app = require('../server')
    server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.on('listening', r))
    base = `http://127.0.0.1:${server.address().port}`
  })

  after(() => {
    server.close()
    fakeAi.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  async function login(username, password) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tickets' },
      body: JSON.stringify({ username, password }),
    })
    assert.strictEqual(res.status, 200)
    return res.headers.get('set-cookie').split(';')[0]
  }

  const call = (cookie, p, opts = {}) => fetch(`${base}/api${p}`, {
    ...opts,
    headers: { Cookie: cookie, 'X-Requested-With': 'tickets', ...(opts.json ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  })

  function newIssueForm(text, files = []) {
    const form = new FormData()
    form.append('text', text)
    for (const [name, content, type] of files) form.append('files', new Blob([content], { type }), name)
    return form
  }

  test('rejects wrong passwords and unauthenticated requests', async () => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tickets' },
      body: JSON.stringify({ username: 'anna', password: 'nope' }),
    })
    assert.strictEqual(res.status, 401)
    assert.strictEqual((await fetch(`${base}/api/issues`)).status, 401)
    assert.strictEqual((await fetch(`${base}/api/issues`, { headers: { Cookie: 'tickets_session=forged.token' } })).status, 401)
  })

  test('rejects state-changing requests without the CSRF header', async () => {
    const cookie = await login('anna', 'anna-password-1')
    const res = await fetch(`${base}/api/issues`, { method: 'POST', headers: { Cookie: cookie }, body: newIssueForm('Some long enough text') })
    assert.strictEqual(res.status, 403)
  })

  test('creates an issue file from the AI draft, with attachments', async () => {
    aiReply = '```json\n' + JSON.stringify({
      title: 'Add Excel export to the Sòcies page',
      slug: 'add-excel-export-to-partners',
      type: 'improvement',
      priority: 'medium',
      project: ['projectes-front', 'not-a-project'],
      description: 'Users cannot export the member list.',
      steps: [],
      expected: '',
      actual: '',
      acceptance_criteria: ['The Sòcies page has an export button'],
      questions: ['Which columns should be exported?'],
    }) + '\n```'
    const cookie = await login('anna', 'anna-password-1')
    const res = await call(cookie, '/issues', {
      method: 'POST',
      body: newIssueForm('Voldria exportar les sòcies a Excel', [['captura.png', 'PNGDATA', 'image/png'], ['notes.txt', 'some notes', 'text/plain']]),
    })
    assert.strictEqual(res.status, 201)
    const { id, ai } = await res.json()
    assert.strictEqual(id, '001')
    assert.strictEqual(ai, true)
    assert.match(aiRequest.body.messages[1].content, /notes\.txt[\s\S]*some notes/)
    assert.strictEqual(aiRequest.headers.authorization, 'Bearer test-key')

    const file = path.join(dataDir, 'issues', '001-add-excel-export-to-partners.md')
    const md = fs.readFileSync(file, 'utf8')
    assert.match(md, /^---\nid: 001\ntitle: Add Excel export to the Sòcies page\ntype: improvement\nstatus: todo\npriority: medium\nproject: projectes-front\n/)
    assert.match(md, /# 001 — Add Excel export to the Sòcies page/)
    assert.match(md, /- \[ \] Covered by a test/)
    assert.match(md, /- \[ \] Question: Which columns should be exported\?/)
    assert.match(md, /> Voldria exportar les sòcies a Excel/)
    assert.match(md, /## Log\n- \d{4}-\d{2}-\d{2} — created\n$/)

    const { issue } = await (await call(cookie, '/issues/001')).json()
    assert.strictEqual(issue.attachments.length, 2)
    const img = await call(cookie, `/issues/001/files/${issue.attachments[0].file}`)
    assert.strictEqual(img.headers.get('content-type'), 'image/png')
    assert.strictEqual(await img.text(), 'PNGDATA')
    const txt = await call(cookie, `/issues/001/files/${issue.attachments[1].file}`)
    assert.match(txt.headers.get('content-disposition'), /^attachment/)
  })

  test('falls back to the raw report when the AI fails', async () => {
    aiReply = null
    const cookie = await login('pere', 'pere-password-1')
    const res = await call(cookie, '/issues', { method: 'POST', body: newIssueForm('La factura surt amb data incorrecta\nDetalls...') })
    const { id, ai } = await res.json()
    assert.strictEqual(ai, false)
    const { issue } = await (await call(cookie, `/issues/${id}`)).json()
    assert.strictEqual(issue.title, 'La factura surt amb data incorrecta')
    assert.match(issue.html, /AI unavailable/)
  })

  test('rejects disallowed file types', async () => {
    const cookie = await login('anna', 'anna-password-1')
    const res = await call(cookie, '/issues', { method: 'POST', body: newIssueForm('Text long enough here', [['evil.html', '<script>', 'text/html']]) })
    assert.strictEqual(res.status, 400)
    assert.deepStrictEqual(fs.readdirSync(path.join(dataDir, 'tmp')), [])
  })

  test('users only see and change their own issues; admin sees all', async () => {
    const anna = await login('anna', 'anna-password-1')
    const pere = await login('pere', 'pere-password-1')
    const admin = await login('admin', 'admin-password-1')

    assert.deepStrictEqual((await (await call(anna, '/issues')).json()).issues.map((i) => i.id), ['001'])
    assert.strictEqual((await call(pere, '/issues/001')).status, 404)
    assert.strictEqual((await call(pere, '/issues/001', { method: 'PATCH', json: { status: 'done' } })).status, 404)
    assert.deepStrictEqual((await (await call(admin, '/issues')).json()).issues.map((i) => i.id), ['002', '001'])

    assert.strictEqual((await call(anna, '/issues/001', { method: 'PATCH', json: { status: 'nonsense' } })).status, 400)
    assert.strictEqual((await call(anna, '/issues/001', { method: 'PATCH', json: { status: 'blocked' } })).status, 200)
    assert.strictEqual((await call(admin, '/issues/001', { method: 'PATCH', json: { status: 'done' } })).status, 200)
    const md = fs.readFileSync(path.join(dataDir, 'issues', '001-add-excel-export-to-partners.md'), 'utf8')
    assert.match(md, /\nstatus: done\n/)
    assert.match(md, /— status todo → blocked \(anna\)\n- .* — status blocked → done \(admin\)\n$/)
  })

  test('escapes raw HTML and unsafe links in the issue body', async () => {
    aiReply = JSON.stringify({
      title: 'XSS attempt',
      type: 'bug',
      description: '<img src=x onerror=alert(1)> [click](javascript:alert(1)) [ok](https://example.com)',
      acceptance_criteria: ['nothing'],
    })
    const cookie = await login('anna', 'anna-password-1')
    const { id } = await (await call(cookie, '/issues', { method: 'POST', body: newIssueForm('<script>alert(1)</script> please') })).json()
    const { issue } = await (await call(cookie, `/issues/${id}`)).json()
    assert.doesNotMatch(issue.html, /<img|<script|javascript:/)
    assert.match(issue.html, /&lt;img/)
    assert.match(issue.html, /href="https:\/\/example.com"/)
  })

  test('password change invalidates existing sessions', async () => {
    const cookie = await login('pere', 'pere-password-1')
    require('../lib/users').upsert({ username: 'pere', password: 'pere-password-2' })
    assert.strictEqual((await call(cookie, '/me')).status, 401)
  })

  test('a follow-up lets the AI rewrite the ticket, keeping manual notes and ticked criteria', async () => {
    const file = path.join(dataDir, 'issues', '001-add-excel-export-to-partners.md')
    // A developer ticks a criterion and adds a note by hand.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
      .replace('- [ ] The Sòcies page has an export button', '- [x] The Sòcies page has an export button')
      .replace('- [ ] Question: Which columns', '- Dev note: reuse ContactsTable export\n- [ ] Question: Which columns'))

    aiReply = JSON.stringify({
      title: 'Add Excel export with all columns to the Sòcies page',
      type: 'improvement',
      priority: 'high',
      project: ['projectes-front'],
      description: 'Users cannot export the member list. They need every column.',
      acceptance_criteria: ['The Sòcies page has an export button', 'The export includes all columns', 'Covered by a test (whatever)'],
      questions: [],
      reply: "He afegit que cal exportar totes les columnes.",
    })
    const anna = await login('anna', 'anna-password-1')
    const form = newIssueForm('Totes les columnes, si us plau', [['extra.png', 'PNG2', 'image/png']])
    const res = await call(anna, '/issues/001/messages', { method: 'POST', body: form })
    assert.strictEqual(res.status, 201)
    assert.deepStrictEqual(await res.json(), { ai: true, reply: 'He afegit que cal exportar totes les columnes.' })
    assert.match(aiRequest.body.messages[1].content, /Current issue:[\s\S]*# 001 — Add Excel export[\s\S]*New message from the user:[\s\S]*Totes les columnes/)

    const md = fs.readFileSync(file, 'utf8')
    assert.match(md, /\ntitle: Add Excel export with all columns to the Sòcies page\n/)
    assert.match(md, /\npriority: high\n/)
    assert.match(md, /# 001 — Add Excel export with all columns to the Sòcies page/)
    assert.match(md, /- \[x\] The Sòcies page has an export button\n- \[ \] The export includes all columns\n- \[ \] Covered by a test \(unit/)
    assert.strictEqual(md.match(/Covered by a test/g).length, 1)
    assert.match(md, /- Dev note: reuse ContactsTable export/)
    assert.doesNotMatch(md, /Question: Which columns/)
    assert.match(md, /Attachments: `captura.png`, `notes.txt`, `extra.png`/)
    assert.match(md, /## Original report\n> Voldria exportar/)
    assert.match(md, /## Conversation\n\*\*[\d-]+ · Anna \(anna\):\*\*\n> Totes les columnes, si us plau\n\n\*\*[\d-]+ · AI:\*\*\n> He afegit/)
    assert.match(md, /## Conversation[\s\S]*## Log\n[\s\S]*follow-up from anna \(AI updated the ticket\)\n$/)

    const { issue } = await (await call(anna, '/issues/001')).json()
    assert.strictEqual(issue.attachments.length, 3)
    assert.strictEqual(await (await call(anna, `/issues/001/files/${issue.attachments[2].file}`)).text(), 'PNG2')
  })

  test('a follow-up is still recorded when the AI fails, and others cannot post', async () => {
    aiReply = null
    const anna = await login('anna', 'anna-password-1')
    const before = fs.readFileSync(path.join(dataDir, 'issues', '001-add-excel-export-to-partners.md'), 'utf8')
    const res = await call(anna, '/issues/001/messages', { method: 'POST', body: newIssueForm('I també el NIF') })
    assert.deepStrictEqual(await res.json(), { ai: false, reply: '' })
    const md = fs.readFileSync(path.join(dataDir, 'issues', '001-add-excel-export-to-partners.md'), 'utf8')
    assert.strictEqual(md.split('## Conversation')[0].replace(/updated: .*/, ''), before.split('## Conversation')[0].replace(/updated: .*/, ''))
    assert.match(md, /> I també el NIF\n\n## Log/)
    assert.match(md, /follow-up from anna \(AI unavailable, ticket not rewritten\)\n$/)

    const admin = await login('admin', 'admin-password-1')
    assert.strictEqual((await call(admin, '/issues/001/messages', { method: 'POST', body: newIssueForm('Admin note') })).status, 201)
    const pere = await login('pere', 'pere-password-2')
    assert.strictEqual((await call(pere, '/issues/001/messages', { method: 'POST', body: newIssueForm('Hijack') })).status, 404)
  })

  test('public tickets are readable by everyone but only the author or an admin can change them', async () => {
    aiReply = JSON.stringify({ title: 'Shared idea', type: 'suggestion', description: 'An idea.', acceptance_criteria: ['x'] })
    const anna = await login('anna', 'anna-password-1')
    const pere = await login('pere', 'pere-password-2')
    const admin = await login('admin', 'admin-password-1')

    const form = newIssueForm('Una idea per a tothom', [['shot.png', 'PUB', 'image/png']])
    form.append('public', 'true')
    const { id } = await (await call(anna, '/issues', { method: 'POST', body: form })).json()
    const file = fs.readdirSync(path.join(dataDir, 'issues')).find((f) => f.startsWith(`${id}-`))
    assert.match(fs.readFileSync(path.join(dataDir, 'issues', file), 'utf8'), /\npublic: true\n/)

    // Pere can list, read and download, but not change it.
    assert.ok((await (await call(pere, '/issues')).json()).issues.some((i) => i.id === id && i.public))
    const { issue } = await (await call(pere, `/issues/${id}`)).json()
    assert.strictEqual(issue.canEdit, false)
    assert.strictEqual(await (await call(pere, `/issues/${id}/files/${issue.attachments[0].file}`)).text(), 'PUB')
    assert.strictEqual((await call(pere, `/issues/${id}`, { method: 'PATCH', json: { status: 'done' } })).status, 403)
    assert.strictEqual((await call(pere, `/issues/${id}`, { method: 'PATCH', json: { public: false } })).status, 403)
    assert.strictEqual((await call(pere, `/issues/${id}/messages`, { method: 'POST', body: newIssueForm('meddling') })).status, 403)
    assert.strictEqual((await (await call(anna, `/issues/${id}`)).json()).issue.canEdit, true)

    // Admin makes it private: Pere loses access.
    assert.strictEqual((await call(admin, `/issues/${id}`, { method: 'PATCH', json: { public: 'yes' } })).status, 400)
    assert.strictEqual((await call(admin, `/issues/${id}`, { method: 'PATCH', json: { public: false } })).status, 200)
    assert.strictEqual((await call(pere, `/issues/${id}`)).status, 404)
    assert.strictEqual((await call(pere, `/issues/${id}/files/${issue.attachments[0].file}`)).status, 404)
    assert.match(fs.readFileSync(path.join(dataDir, 'issues', file), 'utf8'), /\npublic: false\n[\s\S]*— made private \(admin\)\n$/)

    // The author can make it public again.
    assert.strictEqual((await call(anna, `/issues/${id}`, { method: 'PATCH', json: { public: true } })).status, 200)
    assert.strictEqual((await call(pere, `/issues/${id}`)).status, 200)
  })

  test('emails the author and admins whose usernames are emails, not the person who acted', async () => {
    const users = require('../lib/users')
    const mailer = require('../lib/mailer')
    users.upsert({ username: 'Marta@Coop.cat', name: 'Marta', role: 'user', password: 'marta-password-1' })
    users.upsert({ username: 'boss@coop.cat', name: 'Boss', role: 'admin', password: 'boss-password-1' })
    users.upsert({ username: 'gone@coop.cat', name: 'Gone', role: 'admin', password: 'gone-password-1' })
    users.setDisabled('gone@coop.cat', true)
    assert.throws(() => users.upsert({ username: 'bad@@coop.cat', password: 'whatever-123' }), /Username/)

    const sent = []
    mailer.setTransport({ sendMail: async (m) => { sent.push(m) } })
    const waitFor = async (n) => {
      for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10))
      assert.strictEqual(sent.length, n)
      return sent.splice(0).sort((a, b) => a.to.localeCompare(b.to))
    }
    try {
      aiReply = JSON.stringify({ title: 'Slow\r\nBcc: x@evil.com', type: 'bug', description: 'Slow.', acceptance_criteria: ['fast'] })
      const marta = await login('marta@coop.cat', 'marta-password-1')
      const boss = await login('boss@coop.cat', 'boss-password-1')
      const { id } = await (await call(marta, '/issues', { method: 'POST', body: newIssueForm('Va molt lent tot') })).json()

      // Created: receipt to the author + every admin with an email (not disabled, not plain usernames).
      let mails = await waitFor(2)
      assert.deepStrictEqual(mails.map((m) => m.to), ['boss@coop.cat', 'marta@coop.cat'])
      assert.strictEqual(mails[0].subject, `[Tiquet #${id}] Slow Bcc: x@evil.com — Nou tiquet`)
      assert.match(mails[0].text, /Marta ha creat el tiquet/)

      // Admin changes the status: only the author is told.
      await call(boss, `/issues/${id}`, { method: 'PATCH', json: { status: 'in-progress' } })
      mails = await waitFor(1)
      assert.strictEqual(mails[0].to, 'marta@coop.cat')
      assert.match(mails[0].subject, /Estat: En procés$/)
      assert.match(mails[0].text, /Estat: Pendent → En procés/)

      // Author adds info: admins are told, with the AI reply.
      aiReply = JSON.stringify({ title: 'Slow', type: 'bug', description: 'Slow everywhere.', acceptance_criteria: ['fast'], reply: 'Entesos, gràcies.' })
      await call(marta, `/issues/${id}/messages`, { method: 'POST', body: newIssueForm('A totes les pàgines') })
      mails = await waitFor(1)
      assert.strictEqual(mails[0].to, 'boss@coop.cat')
      assert.match(mails[0].text, /A totes les pàgines[\s\S]*Resposta de l'IA:\n  Entesos, gràcies\./)

      // A failing SMTP server doesn't break the request.
      mailer.setTransport({ sendMail: async () => { throw new Error('SMTP down') } })
      assert.strictEqual((await call(boss, `/issues/${id}`, { method: 'PATCH', json: { status: 'done' } })).status, 200)
    } finally {
      mailer.setTransport(null)
    }
  })

  test('SSO from an ESSTRAPIS instance creates the user and logs them in, once', async () => {
    const tenants = require('../lib/tenants')
    const sso = require('../lib/sso')
    const coop = tenants.add('coop-a', 'Coop A')
    const other = tenants.add('coop-b', 'Coop B')
    const ssoGet = (tenant, token) => fetch(`${base}/sso?tenant=${tenant}&token=${token}`, { redirect: 'manual' })
    const tokenFor = (t, email, extra = {}) => sso.createToken({ tenant: t.tenant, apiKey: t.apiKey, email, name: 'Núria', ...extra })

    const token = tokenFor(coop, 'Nuria@Coop-A.cat')
    const res = await ssoGet('coop-a', token)
    assert.strictEqual(res.status, 303)
    assert.strictEqual(res.headers.get('location'), '/#/')
    const cookie = res.headers.get('set-cookie').split(';')[0]
    const { user } = await (await call(cookie, '/me')).json()
    assert.deepStrictEqual(user, { username: 'nuria@coop-a.cat', name: 'Núria', role: 'user', tenant: 'coop-a' })

    // The tenant is recorded on the user's tickets.
    aiReply = JSON.stringify({ title: 'From SSO', type: 'bug', description: 'x', acceptance_criteria: ['y'] })
    const { id } = await (await call(cookie, '/issues', { method: 'POST', body: newIssueForm('Des de la instància') })).json()
    const file = fs.readdirSync(path.join(dataDir, 'issues')).find((f) => f.startsWith(`${id}-`))
    assert.match(fs.readFileSync(path.join(dataDir, 'issues', file), 'utf8'), /\nauthor: nuria@coop-a.cat\ntenant: coop-a\n/)

    // Replay, wrong tenant, tampering, bad tenant names.
    assert.strictEqual((await ssoGet('coop-a', token)).status, 401)
    assert.strictEqual((await ssoGet('coop-b', tokenFor(coop, 'x@coop-a.cat'))).status, 401)
    assert.strictEqual((await ssoGet('coop-a', tokenFor(coop, 'x@coop-a.cat').slice(0, -2) + 'AA')).status, 401)
    assert.strictEqual((await ssoGet('nope', tokenFor(coop, 'x@coop-a.cat'))).status, 401)
    // Expired, or valid for too long.
    assert.strictEqual((await ssoGet('coop-a', tokenFor(coop, 'x@coop-a.cat', { ttlSec: -120 }))).status, 401)
    assert.strictEqual((await ssoGet('coop-a', tokenFor(coop, 'x@coop-a.cat', { ttlSec: 3600 }))).status, 401)
    // Another tenant can't take over this user, nor sign in as an admin or a password-only user.
    assert.strictEqual((await ssoGet('coop-b', tokenFor(other, 'nuria@coop-a.cat'))).status, 401)
    assert.strictEqual((await ssoGet('coop-b', tokenFor(other, 'boss@coop.cat'))).status, 401)
    assert.strictEqual((await ssoGet('coop-b', tokenFor(other, 'marta@coop.cat'))).status, 401)
    assert.strictEqual((await ssoGet('coop-a', tokenFor(coop, 'not-an-email'))).status, 401)
    // A disabled tenant can't sign anyone in.
    tenants.setDisabled('coop-a', true)
    assert.strictEqual((await ssoGet('coop-a', tokenFor(coop, 'nuria@coop-a.cat'))).status, 401)
    tenants.setDisabled('coop-a', false)
    // A fresh token for the same user works again.
    assert.strictEqual((await ssoGet('coop-a', tokenFor(coop, 'nuria@coop-a.cat'))).status, 303)
  })

  test('an unreachable SMTP server is checked once, then skipped without blocking requests', async () => {
    const mailer = require('../lib/mailer')
    let verifies = 0
    let sends = 0
    mailer.setTransport({
      verify: async () => { verifies++; throw new Error('getaddrinfo ENOTFOUND smtp.invalid') },
      sendMail: async () => { sends++ },
    })
    try {
      const boss = await login('boss@coop.cat', 'boss-password-1')
      const { issues: list } = await (await call(boss, '/issues')).json()
      const id = list.find((i) => i.author === 'marta@coop.cat').id
      for (const status of ['blocked', 'review', 'todo']) {
        const started = Date.now()
        assert.strictEqual((await call(boss, `/issues/${id}`, { method: 'PATCH', json: { status } })).status, 200)
        assert.ok(Date.now() - started < 1000)
      }
      await new Promise((r) => setTimeout(r, 50))
      assert.strictEqual(verifies, 1)
      assert.strictEqual(sends, 0)
      assert.strictEqual(await mailer.ready(), false)
      assert.strictEqual(verifies, 1)
    } finally {
      mailer.setTransport(null)
    }
  })
})
