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

// Builds the issue body from the structured draft (AI output or fallback).
function buildBody(id, draft, { originalText, attachments, date }) {
  const parts = [`# ${id} — ${draft.title}`, `## Description\n${draft.description.trim()}`]
  if (draft.steps.length) parts.push(`## Steps to reproduce / context\n${draft.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
  if (draft.expected || draft.actual) {
    const lines = []
    if (draft.expected) lines.push(`- **Expected:** ${draft.expected}`)
    if (draft.actual) lines.push(`- **Actual:** ${draft.actual}`)
    parts.push(`## Expected vs actual\n${lines.join('\n')}`)
  }
  const criteria = [...draft.acceptance_criteria]
  if (draft.type === 'bug' || draft.type === 'improvement') criteria.push(TEST_CRITERION)
  parts.push(`## Acceptance criteria\n${bullets(criteria, true)}`)
  const notes = draft.questions.map((q) => `[ ] Question: ${q}`)
  if (attachments.length) notes.push(`Attachments: ${attachments.map((a) => `\`${a.name}\``).join(', ')}`)
  if (notes.length) parts.push(`## Notes / investigation\n${bullets(notes)}`)
  parts.push(`## Original report\n${originalText.trim().split('\n').map((l) => `> ${l}`).join('\n')}`)
  parts.push(`## Log\n- ${date} — created${draft.ai ? '' : ' (AI unavailable, written from the raw report)'}`)
  return parts.join('\n\n')
}

function create({ draft, originalText, author, attachments = [] }) {
  return withLock(() => {
    const id = nextId()
    const date = today()
    const meta = {
      title: draft.title,
      type: draft.type,
      status: 'todo',
      priority: draft.priority,
      project: draft.project.join(', '),
      source: `${author.name} (${author.username}) via tickets web`,
      author: author.username,
      created: date,
      updated: date,
    }
    if (attachments.length) meta.attachments = attachments
    const body = buildBody(id, draft, { originalText, attachments, date })
    writeFileAtomic(path.join(config.issuesDir, `${id}-${slugify(draft.slug || draft.title)}.md`), serialize(id, meta, body))
    return id
  })
}

// Changes the status and appends a line to the Log section (always the last one).
function setStatus(id, status, byUser) {
  if (!STATUSES.includes(status)) throw new Error('Invalid status')
  return withLock(() => {
    const file = fileForId(id)
    if (!file) return null
    const { meta, body } = parseFile(fs.readFileSync(file, 'utf8'))
    if (meta.status === status) return get(id)
    const date = today()
    const line = `- ${date} — status ${meta.status} → ${status} (${byUser.username})`
    meta.status = status
    meta.updated = date
    const newBody = /\n## Log\n/.test(`\n${body}`) ? `${body.replace(/\n*$/, '')}\n${line}\n` : `${body.replace(/\n*$/, '')}\n\n## Log\n${line}\n`
    writeFileAtomic(file, serialize(id, meta, newBody))
    return get(id)
  })
}

module.exports = { STATUSES, CLOSED, PRIORITIES, TYPES, ID_RE, list, get, create, setStatus, slugify, buildBody, today, nextId }
