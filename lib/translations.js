// Catalan version of each issue, for the UI and the emails. The .md file stays in
// English (the team and the projectes/issues tooling read it); the translation is a
// cache in data/translations/NNN.json, keyed by a hash of the English parts it
// covers, so hand edits to the .md are picked up the next time the ticket is opened.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const ai = require('./ai')
const { splitBody, joinBody } = require('./issues')
const { label } = require('./labels')
const { writeFileAtomic } = require('./fsutil')

// Already in the user's language: kept as they are, only the heading changes.
const VERBATIM = { 'Original report': 'Informe original', Conversation: 'Conversa' }
// Written by this app in fixed phrases, translated here so a status change doesn't need the AI.
const LOG = 'Log'
const LOG_PHRASES = [
  [/— created \(AI unavailable, written from the raw report\)$/, () => "— creat (IA no disponible, escrit a partir de l'informe original)"],
  [/— created$/, () => '— creat'],
  [/— follow-up from (.+) \(AI updated the ticket\)$/, (m) => `— nova informació de ${m[1]} (l'IA ha actualitzat el tiquet)`],
  [/— follow-up from (.+) \(AI unavailable, ticket not rewritten\)$/, (m) => `— nova informació de ${m[1]} (IA no disponible, tiquet no reescrit)`],
  [/— status (\S+) → (\S+) \((.+)\)$/, (m) => `— estat ${label(m[1])} → ${label(m[2])} (${m[3]})`],
  [/— made (public|private) \((.+)\)$/, (m) => `— fet ${m[1] === 'public' ? 'públic' : 'privat'} (${m[2]})`],
]
const FAILURE_BACKOFF_MS = 10 * 60 * 1000

const inflight = new Map() // `${id}:${hash}` -> Promise
const failures = new Map() // id -> { hash, at }

const fileFor = (id) => path.join(config.translationsDir, `${id}.json`)

function read(id) {
  try { return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')) } catch { return null }
}

function parts(issue) {
  const { top, sections } = splitBody(issue.body)
  const translatable = sections.filter((s) => !VERBATIM[s.heading] && s.heading !== LOG)
  const hash = crypto.createHash('sha256').update(JSON.stringify([issue.title, top, translatable])).digest('hex')
  return { top, sections, translatable, hash }
}

function translateLog(content) {
  return content.split('\n').map((line) => {
    for (const [re, fn] of LOG_PHRASES) {
      const m = line.match(re)
      if (m) return line.slice(0, m.index) + fn(m)
    }
    return line
  }).join('\n')
}

function assemble(p, t) {
  let i = 0
  const sections = p.sections.map((s) => {
    if (VERBATIM[s.heading]) return { heading: VERBATIM[s.heading], content: s.content }
    if (s.heading === LOG) return { heading: 'Historial', content: translateLog(s.content) }
    return t.sections[i++]
  })
  return { title: t.title, body: joinBody(t.top || p.top, sections), translated: true }
}

function fromCache(issue, p) {
  const t = read(issue.id)
  return t && t.hash === p.hash && t.sections.length === p.translatable.length ? assemble(p, t) : null
}

const english = (issue) => ({ title: issue.title, body: issue.body, translated: false })

// The Catalan version if it's cached and up to date, else the English one. Never calls the AI.
function cached(issue) {
  return fromCache(issue, parts(issue)) || english(issue)
}

// Catalan title for the list, from the cache, as long as the English title hasn't changed.
function title(summary) {
  const t = read(summary.id)
  return t && t.titleEn === summary.title ? t.title : summary.title
}

function refresh(issue, p) {
  const failed = failures.get(issue.id)
  if (failed && failed.hash === p.hash && Date.now() - failed.at < FAILURE_BACKOFF_MS) return Promise.resolve(null)
  const key = `${issue.id}:${p.hash}`
  if (inflight.has(key)) return inflight.get(key)
  const run = ai.translateIssue({ title: issue.title, top: p.top, sections: p.translatable })
    .then((t) => {
      if (!t) {
        failures.set(issue.id, { hash: p.hash, at: Date.now() })
        return null
      }
      failures.delete(issue.id)
      writeFileAtomic(fileFor(issue.id), `${JSON.stringify({ hash: p.hash, titleEn: issue.title, ...t }, null, 2)}\n`)
      return assemble(p, t)
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, run)
  return run
}

// Translates the issue when the cache is missing or stale. Waits up to waitMs (all the
// way when omitted); on timeout or failure returns the English version, and a pending
// translation keeps going so the next view gets it.
async function ensure(issue, waitMs) {
  if (!issue) return null
  const p = parts(issue)
  const hit = fromCache(issue, p)
  if (hit) return hit
  if (!config.ai.apiKey) return english(issue)
  const run = refresh(issue, p)
  const result = waitMs === undefined
    ? await run
    : await Promise.race([run, new Promise((r) => setTimeout(r, waitMs, null).unref())])
  return result || english(issue)
}

module.exports = { cached, title, ensure, translateLog }
