// Email notifications. Users whose username is an email address get a plain-text
// email when one of their tickets changes; admins with an email get every change.
// The person who made the change is not notified (except on creation, as a receipt).
const nodemailer = require('nodemailer')
const config = require('./config')
const users = require('./users')

const LABELS = {
  todo: 'Pendent', 'in-progress': 'En procés', blocked: 'Bloquejat', review: 'En revisió', done: 'Fet', wontfix: 'Descartat',
  bug: 'Error', improvement: 'Millora', suggestion: 'Suggeriment',
  low: 'baixa', medium: 'mitjana', high: 'alta', urgent: 'urgent',
}
const label = (k) => LABELS[k] || k

let transport = null

function getTransport() {
  if (transport) return transport
  if (!config.smtp.host) return null
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  })
  return transport
}

// For tests.
function setTransport(t) { transport = t }

function enabled() {
  return Boolean(getTransport())
}

function recipients(issue, actor, { includeActor = false } = {}) {
  const all = users.load().filter((u) => !u.disabled && users.isEmail(u.username))
  const to = all.filter((u) => u.username === issue.author || u.role === 'admin')
  return [...new Set(to.map((u) => u.username))].filter((e) => includeActor || e !== actor.username)
}

const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').slice(0, 150)
const indent = (text) => String(text).trim().split('\n').map((l) => `  ${l}`).join('\n')

function issueLink(issue) {
  return config.publicUrl ? `${config.publicUrl}/#/issue/${issue.id}` : ''
}

async function send(issue, actor, { subject, lines, includeActor }) {
  try {
    const t = getTransport()
    if (!t || !issue) return
    const to = recipients(issue, actor, { includeActor })
    if (!to.length) return
    const link = issueLink(issue)
    const text = [
      ...lines,
      '',
      ...(link ? [`Obre el tiquet: ${link}`, ''] : []),
      '—',
      'ESSTRAPIS · Tiquets. Reps aquest correu perquè ets l\'autor del tiquet o administrador.',
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

module.exports = { enabled, setTransport, recipients, created, changed, followUp }
