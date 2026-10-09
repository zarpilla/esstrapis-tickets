// Issues are stored as Markdown files with YAML frontmatter, in the same format
// as the projectes/issues folder (NNN-slug.md), so they can be copied over as-is.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const YAML = require('yaml')
const config = require('./config')
const { writeFileAtomic, createLock } = require('./fsutil')

const STATUSES = ['todo', 'in-progress', 'blocked', 'review', 'done', 'wontfix']
const CLOSED = ['done', 'wontfix']
const PRIORITIES = ['low', 'medium', 'high', 'urgent']
const TYPES = ['bug', 'improvement', 'suggestion']
const ID_RE = /^\d{3,}$/
const FILE_RE = /^(\d{3,})-[a-z0-9-]+\.md$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// Owned by this site (who wrote the ticket, its files): kept from the stored file
// whatever a file sent through the API says.
const SITE_FIELDS = ['author', 'tenant', 'attachments']
const TEST_CRITERION = 'Covered by a test (unit, or API-level in projectes-v5) that fails before the fix'

const withLock = createLock()

function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: config.timezone })
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-') || 'issue'
}

function parseFile(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: content }
  return { meta: YAML.parse(m[1]) || {}, body: m[2] }
}

function serialize(id, meta, body) {
  const { id: _ignored, ...rest } = meta
  // `id: 019` unquoted, like the hand-written issues.
  const front = `id: ${id}\n` + YAML.stringify(rest, { lineWidth: 0 })
  return `---\n${front}---\n\n${body.replace(/^\n+/, '').replace(/\n*$/, '\n')}`
}

function listFiles() {
  if (!fs.existsSync(config.issuesDir)) return []
  return fs.readdirSync(config.issuesDir).filter((f) => FILE_RE.test(f))
}

function fileForId(id) {
  if (!ID_RE.test(String(id))) return null
  const f = listFiles().find((name) => name.startsWith(`${id}-`))
  return f ? path.join(config.issuesDir, f) : null
}

function summary(id, meta) {
  return {
    id,
    title: meta.title,
    type: meta.type,
    status: meta.status,
    priority: meta.priority,
    project: meta.project,
    author: meta.author,
    tenant: meta.tenant || null,
    public: meta.public === true,
    created: meta.created,
    updated: meta.updated,
  }
}

function list() {
  return listFiles().map((f) => {
    const { meta } = parseFile(fs.readFileSync(path.join(config.issuesDir, f), 'utf8'))
    return summary(f.match(FILE_RE)[1], meta)
  }).sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))
}

function get(id) {
  const file = fileForId(id)
  if (!file) return null
  const { meta, body } = parseFile(fs.readFileSync(file, 'utf8'))
  return { ...summary(id, meta), attachments: meta.attachments || [], body }
}

function nextId() {
  const max = listFiles().reduce((acc, f) => Math.max(acc, Number(f.match(FILE_RE)[1])), config.issueIdStart - 1)
  return String(max + 1).padStart(3, '0')
}

const bullets = (items, checkbox) => items.map((s) => `- ${checkbox ? '[ ] ' : ''}${s}`).join('\n')
const quote = (text) => text.trim().split('\n').map((l) => `> ${l}`).join('\n')

// Sections written from the AI draft; a follow-up regenerates them. Any other
// section (Original report, Conversation, Log, or one added by hand) is kept.
const GENERATED = ['Description', 'Steps to reproduce / context', 'Expected vs actual', 'Acceptance criteria', 'Notes / investigation']

function splitBody(body) {
  const sections = []
  let top = ''
  for (const chunk of `\n${body}`.split(/\n(?=## )/)) {
    const m = chunk.match(/^## (.*)\n?([\s\S]*)$/)
    if (m) sections.push({ heading: m[1].trim(), content: m[2].trim() })
    else top = chunk.trim()
  }
  return { top, sections }
}

function joinBody(top, sections) {
  return [top, ...sections.map((s) => `## ${s.heading}\n${s.content}`)].filter(Boolean).join('\n\n')
}

function generatedSections(draft, { attachments, keepNotes = [], checked = new Set() }) {
  const sections = [{ heading: 'Description', content: draft.description.trim() }]
  if (draft.steps.length) sections.push({ heading: 'Steps to reproduce / context', content: draft.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') })
  if (draft.expected || draft.actual) {
    const lines = []
    if (draft.expected) lines.push(`- **Expected:** ${draft.expected}`)
    if (draft.actual) lines.push(`- **Actual:** ${draft.actual}`)
    sections.push({ heading: 'Expected vs actual', content: lines.join('\n') })
  }
  const criteria = draft.acceptance_criteria.filter((c) => !c.startsWith('Covered by a test'))
  if (draft.type === 'bug' || draft.type === 'improvement') criteria.push(TEST_CRITERION)
  sections.push({ heading: 'Acceptance criteria', content: criteria.map((c) => `- [${checked.has(c) ? 'x' : ' '}] ${c}`).join('\n') })
  const notes = [...keepNotes, ...draft.questions.map((q) => `- [ ] Question: ${q}`)]
  if (attachments.length) notes.push(`- Attachments: ${attachments.map((a) => `\`${a.name}\``).join(', ')}`)
  if (notes.length) sections.push({ heading: 'Notes / investigation', content: notes.join('\n') })
  return sections
}

function buildBody(id, draft, { originalText, attachments, date }) {
  return joinBody(`# ${id} — ${draft.title}`, [
    ...generatedSections(draft, { attachments }),
    { heading: 'Original report', content: quote(originalText) },
    { heading: 'Log', content: `- ${date} — created${draft.ai ? '' : ' (AI unavailable, written from the raw report)'}` },
  ])
}

function conversationEntry(date, who, text) {
  return `**${date} · ${who}:**\n${quote(text)}`
}

function create({ draft, originalText, author, attachments = [], isPublic = false }) {
  return withLock(() => {
    const id = nextId()
    const date = today()
    const meta = {
      title: draft.title,
      type: draft.type,
      status: 'todo',
      priority: draft.priority,
      project: draft.project.join(', '),
      source: `${author.name} (${author.username}${author.tenant ? `, ${author.tenant}` : ''}) via tickets web`,
      author: author.username,
      ...(author.tenant ? { tenant: author.tenant } : {}),
      public: isPublic,
      created: date,
      updated: date,
    }
    if (attachments.length) meta.attachments = attachments
    const body = buildBody(id, draft, { originalText, attachments, date })
    writeFileAtomic(path.join(config.issuesDir, `${id}-${slugify(draft.slug || draft.title)}.md`), serialize(id, meta, body))
    return id
  })
}

function appendLog(body, line) {
  const { top, sections } = splitBody(body)
  const log = sections.find((s) => s.heading === 'Log')
  if (log) log.content = `${log.content}\n${line}`
  else sections.push({ heading: 'Log', content: line })
  return joinBody(top, sections)
}

// Adds a user message (and the AI reply) to the Conversation section. When the AI
// produced a revised draft, the generated sections are rewritten from it, keeping
// hand-written notes and ticked acceptance criteria.
function addFollowUp(id, { draft, message, reply, author, attachments = [] }) {
  return withLock(() => {
    const file = fileForId(id)
    if (!file) return null
    const { meta, body } = parseFile(fs.readFileSync(file, 'utf8'))
    const date = today()
    let { top, sections } = splitBody(body)
    meta.attachments = [...(meta.attachments || []), ...attachments]
    if (!meta.attachments.length) delete meta.attachments

    if (draft) {
      const old = Object.fromEntries(sections.map((s) => [s.heading, s.content]))
      const keepNotes = (old['Notes / investigation'] || '').split('\n')
        .filter((l) => l.trim() && !/^- (\[.\] )?(Question:|Attachments:)/.test(l))
      const checked = new Set((old['Acceptance criteria'] || '').split('\n')
        .map((l) => l.match(/^- \[x\] (.*)$/i)).filter(Boolean).map((m) => m[1].trim()))
      const fresh = generatedSections(draft, { attachments: meta.attachments || [], keepNotes, checked })
      const at = sections.findIndex((s) => GENERATED.includes(s.heading))
      sections = sections.filter((s) => !GENERATED.includes(s.heading))
      sections.splice(at < 0 ? 0 : at, 0, ...fresh)
      Object.assign(meta, { title: draft.title, type: draft.type, priority: draft.priority, project: draft.project.join(', ') })
      top = top.replace(/^# .*$/m, `# ${id} — ${draft.title}`)
    }

    let convo = sections.find((s) => s.heading === 'Conversation')
    if (!convo) {
      convo = { heading: 'Conversation', content: '' }
      const logAt = sections.findIndex((s) => s.heading === 'Log')
      sections.splice(logAt < 0 ? sections.length : logAt, 0, convo)
    }
    const entries = [conversationEntry(date, `${author.name} (${author.username})`, message)]
    if (reply) entries.push(conversationEntry(date, 'AI', reply))
    convo.content = [convo.content, ...entries].filter(Boolean).join('\n\n')

    meta.updated = date
    const what = draft ? 'AI updated the ticket' : 'AI unavailable, ticket not rewritten'
    writeFileAtomic(file, serialize(id, meta, appendLog(joinBody(top, sections), `- ${date} — follow-up from ${author.username} (${what})`)))
    return get(id)
  })
}

// Changes status and/or visibility, logging each change.
function update(id, changes, byUser) {
  if (changes.status !== undefined && !STATUSES.includes(changes.status)) throw new Error('Invalid status')
  return withLock(() => {
    const file = fileForId(id)
    if (!file) return null
    const { meta, body } = parseFile(fs.readFileSync(file, 'utf8'))
    const date = today()
    const lines = []
    if (changes.status !== undefined && changes.status !== meta.status) {
      lines.push(`- ${date} — status ${meta.status} → ${changes.status} (${byUser.username})`)
      meta.status = changes.status
    }
    if (changes.public !== undefined && changes.public !== (meta.public === true)) {
      lines.push(`- ${date} — made ${changes.public ? 'public' : 'private'} (${byUser.username})`)
      meta.public = changes.public
    }
    if (!lines.length) return get(id)
    meta.updated = date
    writeFileAtomic(file, serialize(id, meta, lines.reduce(appendLog, body)))
    return get(id)
  })
}

// --- Whole files, for the team's API (projectes/issues sync) ------------------

const hashOf = (content) => crypto.createHash('sha256').update(content).digest('hex')
const httpError = (status, message) => Object.assign(new Error(message), { status })

// The stored file as it is, with a hash to send back as If-Match.
function raw(id) {
  const file = fileForId(id)
  if (!file) return null
  const markdown = fs.readFileSync(file, 'utf8')
  return { id, file: path.basename(file), hash: hashOf(markdown), attachments: parseFile(markdown).meta.attachments || [], markdown }
}

function checkMeta(meta) {
  const errors = []
  if (typeof meta.title !== 'string' || !meta.title.trim()) errors.push('title is required')
  if (!TYPES.includes(meta.type)) errors.push(`type must be one of ${TYPES.join(', ')}`)
  if (!STATUSES.includes(meta.status)) errors.push(`status must be one of ${STATUSES.join(', ')}`)
  if (!PRIORITIES.includes(meta.priority)) errors.push(`priority must be one of ${PRIORITIES.join(', ')}`)
  if (meta.project != null && typeof meta.project !== 'string') errors.push('project must be a string')
  if (typeof meta.public !== 'boolean') errors.push('public must be true or false')
  for (const k of ['created', 'updated']) if (!DATE_RE.test(String(meta[k]))) errors.push(`${k} must be YYYY-MM-DD`)
  if (errors.length) throw httpError(400, errors.join('; '))
}

// Validates a file sent through the API and gives it this id: the frontmatter id and
// the "# NNN — " heading are rewritten, and the site's own fields come from `stored`.
function prepare(id, markdown, stored) {
  if (typeof markdown !== 'string' || !/^---\r?\n/.test(markdown)) throw httpError(400, 'markdown must be the issue file, starting with YAML frontmatter')
  let parsed
  try { parsed = parseFile(markdown) } catch (err) { throw httpError(400, `Invalid frontmatter: ${err.message}`) }
  // Empty fields (`source:`) are left out rather than written as null.
  const meta = Object.fromEntries(Object.entries(parsed.meta).filter(([, v]) => v !== null))
  for (const k of SITE_FIELDS) {
    if (stored && stored[k] !== undefined) meta[k] = stored[k]
    else delete meta[k]
  }
  if (meta.public === undefined) meta.public = stored ? stored.public === true : false
  meta.created = meta.created || today()
  meta.updated = meta.updated || today()
  checkMeta(meta)
  const body = parsed.body.replace(/^# (?:\d{3,}|N+) — /m, `# ${id} — `)
  return { meta, content: serialize(id, meta, body) }
}

// A slug sent with the file (the local file name) is kept as it is when valid, so
// file names match on both sides; otherwise one is made from the title.
const fileSlug = (slug, title) => (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug || '') && slug.length <= 80 ? slug : slugify(title))

// Creates a ticket from a whole file, with the next free id.
function createRaw(markdown, { slug } = {}) {
  return withLock(() => {
    const id = nextId()
    const { meta, content } = prepare(id, markdown, null)
    writeFileAtomic(path.join(config.issuesDir, `${id}-${fileSlug(slug, meta.title)}.md`), content)
    return id
  })
}

// Creates or replaces ticket `id` with a whole file. ifMatch: the hash the client last
// read (412 if the ticket changed since); ifNoneMatch '*': only create (412 if it exists).
// Returns the ticket as it was before, or null when it is new.
function putRaw(id, markdown, { slug, ifMatch, ifNoneMatch } = {}) {
  if (!ID_RE.test(String(id))) throw httpError(400, 'Invalid id')
  return withLock(() => {
    const file = fileForId(id)
    const current = file ? fs.readFileSync(file, 'utf8') : null
    if (current && ifNoneMatch === '*') throw httpError(412, `Ticket ${id} already exists`)
    if (ifMatch && (!current || ifMatch !== hashOf(current))) throw httpError(412, `Ticket ${id} changed since it was read`)
    const stored = current ? parseFile(current) : null
    const { meta, content } = prepare(id, markdown, stored && stored.meta)
    if (content !== current) writeFileAtomic(file || path.join(config.issuesDir, `${id}-${fileSlug(slug, meta.title)}.md`), content)
    return stored ? { ...summary(id, stored.meta), attachments: stored.meta.attachments || [], body: stored.body } : null
  })
}

// Adds files already stored in uploads/<id>/ to the ticket's attachments. Only the
// frontmatter changes; the body and the Log stay as they are.
function addAttachments(id, attachments) {
  return withLock(() => {
    const file = fileForId(id)
    if (!file) return null
    const { meta, body } = parseFile(fs.readFileSync(file, 'utf8'))
    meta.attachments = [...(meta.attachments || []), ...attachments]
    writeFileAtomic(file, serialize(id, meta, body))
    return get(id)
  })
}

module.exports = { STATUSES, CLOSED, PRIORITIES, TYPES, ID_RE, list, get, create, update, addFollowUp, raw, createRaw, putRaw, addAttachments, slugify, buildBody, splitBody, joinBody, today, nextId }
