// Email notifications. Users whose username is an email address get a plain-text
// email when one of their tickets changes, and so do the people a ticket is shared
// with (even before they first log in); admins with an email get every change.
// The person who made the change is not notified (except on creation, as a receipt).
const nodemailer = require('nodemailer')
const config = require('./config')
const users = require('./users')
const { label } = require('./labels')

let transport = null

// Fail-safe: the SMTP server is checked (verify = connect + auth) before the first
// send, and again after any failure. While it's unreachable or rejects us, mails
// are skipped (and logged) and it's re-checked at most every RETRY_MS, so a wrong
// or placeholder SMTP_HOST never piles up hanging connections.
const RETRY_MS = 10 * 60 * 1000
const health = { ok: null, checkedAt: 0, checking: null }

function getTransport() {
  if (transport) return transport
  if (!config.smtp.host) return null
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  })
  return transport
}

// For tests.
function setTransport(t) {
  transport = t
  Object.assign(health, { ok: null, checkedAt: 0, checking: null })
}

function markFailed(err) {
  if (health.ok !== false) console.error(`[mail] SMTP ${config.smtp.host || '(test)'} unavailable, skipping emails for ${RETRY_MS / 60000} min: ${err.message}`)
  Object.assign(health, { ok: false, checkedAt: Date.now() })
}

// Resolves true when mails can be sent now.
async function ready() {
  const t = getTransport()
  if (!t) return false
  if (health.ok === true) return true
  if (health.ok === false && Date.now() - health.checkedAt < RETRY_MS) return false
  if (!health.checking) {
    health.checking = (typeof t.verify === 'function' ? t.verify() : Promise.resolve(true))
      .then(() => {
        if (health.ok === false) console.log(`[mail] SMTP ${config.smtp.host} reachable again`)
        Object.assign(health, { ok: true, checkedAt: Date.now() })
      })
      .catch(markFailed)
      .finally(() => { health.checking = null })
  }
  await health.checking
  return health.ok === true
}

function enabled() {
  return Boolean(getTransport())
}

function recipients(issue, actor, { includeActor = false } = {}) {
  const all = users.load()
  const disabled = new Set(all.filter((u) => u.disabled).map((u) => u.username))
  const to = all.filter((u) => !u.disabled && users.isEmail(u.username) && (u.username === issue.author || u.role === 'admin'))
  const shared = (issue.sharedWith || []).filter((e) => users.isEmail(e) && !disabled.has(e))
  return [...new Set([...to.map((u) => u.username), ...shared])].filter((e) => includeActor || e !== actor.username)
}

const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 150)
const indent = (text) => String(text).trim().split('\n').map((l) => `  ${l}`).join('\n')

function issueLink(issue) {
  return config.publicUrl ? `${config.publicUrl}/#/issue/${issue.id}` : ''
}

async function send(issue, actor, { subject, lines, includeActor, only }) {
  try {
    if (!issue || !(await ready())) return
    const t = getTransport()
    const to = recipients(issue, actor, { includeActor }).filter((e) => !only || only.includes(e))
    if (!to.length) return
    const link = issueLink(issue)
    const text = [
      ...lines,
      '',
      ...(link ? [`Obre el tiquet: ${link}`, ''] : []),
      '—',
      'ESSTRAPIS · Tiquets. Reps aquest correu perquè ets l\'autor del tiquet, te l\'han compartit o ets administrador.',
    ].join('\n')
    // One message per recipient, so addresses aren't shared between users.
    await Promise.all(to.map((address) => t.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: address,
      subject: oneLine(`[Tiquet #${issue.id}] ${issue.title} — ${subject}`),
      text,
    })))
  } catch (err) {
    console.error(`[mail] notification for #${issue && issue.id} failed:`, err.message)
    markFailed(err)
  }
}

function created(issue, actor) {
  return send(issue, actor, {
    subject: 'Nou tiquet',
    includeActor: true,
    lines: [
      `${actor.name} ha creat el tiquet #${issue.id}: ${issue.title}`,
      '',
      `Tipus: ${label(issue.type)} · Prioritat: ${label(issue.priority)} · ${issue.public ? 'Públic' : 'Privat'}`,
    ],
  })
}

function changed(before, after, actor) {
  const added = (after.sharedWith || []).filter((e) => !(before.sharedWith || []).includes(e))
  return Promise.all([shared(after, actor, added), statusOrVisibility(before, after, actor)])
}

// To the people just added: the ticket is now theirs to read and add to.
function shared(issue, actor, added) {
  if (!added.length) return Promise.resolve()
  return send(issue, actor, {
    subject: 'Compartit amb tu',
    only: added,
    lines: [
      `${actor.name} ha compartit amb tu el tiquet #${issue.id}: ${issue.title}`,
      '',
      'Pots llegir-lo i afegir-hi informació. Entra a Tiquets des d\'ESSTRAPIS amb aquesta adreça de correu.',
    ],
  })
}

function statusOrVisibility(before, after, actor) {
  const lines = []
  if (before.status !== after.status) lines.push(`Estat: ${label(before.status)} → ${label(after.status)}`)
  if (before.public !== after.public) lines.push(`Visibilitat: ${after.public ? 'ara és públic' : 'ara és privat'}`)
  if (!lines.length) return Promise.resolve()
  return send(after, actor, {
    subject: before.status !== after.status ? `Estat: ${label(after.status)}` : 'Visibilitat canviada',
    lines: [`${actor.name} ha actualitzat el tiquet #${after.id}: ${after.title}`, '', ...lines],
  })
}

function followUp(issue, actor, message, reply) {
  const lines = [`${actor.name} ha afegit informació al tiquet #${issue.id}: ${issue.title}`, '', indent(message)]
  if (reply) lines.push('', 'Resposta de l\'IA:', indent(reply))
  return send(issue, actor, { subject: 'Nova informació', lines })
}

module.exports = { enabled, ready, setTransport, recipients, created, changed, followUp }
