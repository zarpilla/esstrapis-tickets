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
})
