// Issues are stored as Markdown files with YAML frontmatter, in the same format
// as the projectes/issues folder (NNN-slug.md), so they can be copied over as-is.
const fs = require('fs')
const path = require('path')
const YAML = require('yaml')
const config = require('./config')
const { writeFileAtomic, createLock } = require('./fsutil')

const STATUSES = ['todo', 'in-progress', 'blocked', 'review', 'done', 'wontfix']
const CLOSED = ['done', 'wontfix']
const PRIORITIES = ['low', 'medium', 'high', 'urgent']
const TYPES = ['bug', 'improvement', 'suggestion']
const ID_RE = /^\d{3,}$/
const FILE_RE = /^(\d{3,})-[a-z0-9-]+\.md$/
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

module.exports = { STATUSES, CLOSED, PRIORITIES, TYPES, ID_RE, list, get, create, update, addFollowUp, slugify, buildBody, splitBody, joinBody, today, nextId }
