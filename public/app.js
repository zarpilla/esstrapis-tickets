'use strict'

const LABELS = {
  todo: 'Pendent', 'in-progress': 'En procés', blocked: 'Bloquejat', review: 'En revisió', done: 'Fet', wontfix: 'Descartat',
  bug: 'Error', improvement: 'Millora', suggestion: 'Suggeriment',
  low: 'Baixa', medium: 'Mitjana', high: 'Alta', urgent: 'Urgent',
}
const label = (k) => LABELS[k] || k || ''

let session = null // { user, statuses, closed, upload }
const view = document.getElementById('view')

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'tickets', ...(options.json ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: options.json ? JSON.stringify(options.json) : options.body,
  })
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/login') { session = null; render(); throw new Error('Sessió caducada') }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`)
  return data
}

function mount(id) {
  view.replaceChildren(document.getElementById(id).content.cloneNode(true))
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else node.setAttribute(k, v)
  }
  node.append(...children.filter((c) => c != null))
  return node
}

const badge = (prefix, value) => el('span', { class: `badge ${prefix}-${value}` }, label(value))

function showError(form, err) {
  const p = form.querySelector('.error')
  p.textContent = err ? err.message : ''
  p.hidden = !err
}

// --- Views ---------------------------------------------------------------------
function renderLogin() {
  mount('tpl-login')
  const form = document.getElementById('login-form')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    showError(form)
    try {
      await api('/login', { method: 'POST', json: Object.fromEntries(new FormData(form)) })
      await loadSession()
      render()
    } catch (err) { showError(form, err) }
  })
}

async function renderHome() {
  mount('tpl-home')
  const form = document.getElementById('new-form')
  const hint = form.querySelector('.hint')
  const fileInput = form.querySelector('input[type=file]')
  fileInput.accept = session.upload.extensions.join(',')
  hint.textContent = `Fins a ${session.upload.maxFiles} fitxers de ${session.upload.maxFileMb} MB: imatges, PDF, text, Office/LibreOffice.`

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    showError(form)
    const button = form.querySelector('button')
    button.disabled = true
    button.textContent = 'Redactant el tiquet…'
    try {
      const { id } = await api('/issues', { method: 'POST', body: new FormData(form) })
      location.hash = `#/issue/${id}`
    } catch (err) {
      showError(form, err)
    } finally {
      button.disabled = false
      button.textContent = 'Envia'
    }
  })

  const filter = document.getElementById('filter')
  filter.append(el('optgroup', { label: 'Per estat' }, ...session.statuses.map((s) => el('option', { value: `status:${s}` }, label(s)))))
  try { filter.value = localStorage.getItem('filter') || 'open' } catch { /* storage blocked */ }
  if (!filter.value) filter.value = 'open'

  const { issues } = await api('/issues')
  const draw = () => {
    try { localStorage.setItem('filter', filter.value) } catch { /* storage blocked */ }
    const isClosed = (i) => session.closed.includes(i.status)
    const f = filter.value
    const shown = issues.filter((i) => f === 'all' || (f.startsWith('status:') ? i.status === f.slice(7) : (f === 'closed') === isClosed(i)))
    document.getElementById('list').replaceChildren(...shown.map((i) => el('tr', {},
      el('td', {}, i.id),
      el('td', {}, el('a', { href: `#/issue/${i.id}` }, i.title || '(sense títol)'), i.public ? el('span', { class: 'badge public', title: 'Visible per a tots els usuaris' }, 'Públic') : null),
      el('td', {}, badge('t', i.type)),
      el('td', {}, el('span', { class: `status s-${i.status}` }, label(i.status))),
      el('td', {}, badge('p', i.priority)),
      el('td', {}, i.authorName),
      el('td', { class: 'nowrap' }, i.updated || ''),
    )))
    document.getElementById('empty').hidden = shown.length > 0
  }
  filter.addEventListener('change', draw)
  draw()
}

async function renderIssue(id, aiReply) {
  mount('tpl-issue')
  const { issue } = await api(`/issues/${encodeURIComponent(id)}`)
  document.title = `#${issue.id} ${issue.title} · Tiquets`
  const set = (k, text) => { view.querySelector(`[data-k="${k}"]`).textContent = text }
  set('type', label(issue.type))
  set('priority', `Prioritat ${label(issue.priority).toLowerCase()}`)
  view.querySelector('[data-k="type"]').classList.add(`t-${issue.type}`)
  view.querySelector('[data-k="priority"]').classList.add(`p-${issue.priority}`)
  set('project', issue.project || '')
  set('author', `per ${issue.authorName} · ${issue.created}`)

  // Rendered server-side from Markdown, with raw HTML escaped and links filtered.
  document.getElementById('body').innerHTML = issue.html

  const select = document.getElementById('status')
  select.replaceChildren(...session.statuses.map((s) => el('option', { value: s }, label(s))))
  select.value = issue.status
  select.className = `status-select s-${issue.status}`
  const publicBox = document.getElementById('public')
  publicBox.checked = issue.public
  const msg = document.getElementById('status-msg')
  const save = async (changes) => {
    msg.textContent = 'Desant…'
    try {
      await api(`/issues/${issue.id}`, { method: 'PATCH', json: changes })
      await renderIssue(id)
      document.getElementById('status-msg').textContent = 'Desat'
    } catch (err) {
      msg.textContent = err.message
      select.value = issue.status
      publicBox.checked = issue.public
    }
  }
  select.addEventListener('change', () => save({ status: select.value }))
  publicBox.addEventListener('change', () => save({ public: publicBox.checked }))

  // Public tickets of other users are read-only.
  if (!issue.canEdit) {
    select.disabled = true
    publicBox.disabled = true
    view.querySelector('.readonly-note').hidden = false
    document.getElementById('followup').remove()
  }

  const replyBox = view.querySelector('.ai-reply')
  if (aiReply) {
    replyBox.hidden = false
    replyBox.textContent = aiReply
  }

  const form = document.getElementById('followup-form')
  if (form) form.querySelector('input[type=file]').accept = session.upload.extensions.join(',')
  form?.addEventListener('submit', async (e) => {
    e.preventDefault()
    showError(form)
    const button = form.querySelector('button')
    button.disabled = true
    button.textContent = 'Actualitzant el tiquet…'
    try {
      const { ai, reply } = await api(`/issues/${issue.id}/messages`, { method: 'POST', body: new FormData(form) })
      await renderIssue(id, ai ? reply : "L'IA no està disponible ara mateix: el missatge s'ha afegit al tiquet sense reescriure'l.")
    } catch (err) {
      showError(form, err)
      button.disabled = false
      button.textContent = 'Envia'
    }
  })

  if (issue.attachments.length) {
    const box = document.getElementById('attachments')
    box.hidden = false
    box.querySelector('ul').replaceChildren(...issue.attachments.map((a) => {
      const href = `/api/issues/${issue.id}/files/${encodeURIComponent(a.file)}`
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(a.file)
      return el('li', {},
        isImage ? el('a', { href, target: '_blank', rel: 'noopener' }, el('img', { src: href, alt: a.name, loading: 'lazy' })) : null,
        el('a', { href, target: '_blank', rel: 'noopener' }, a.name),
        el('span', { class: 'muted' }, ` ${(a.size / 1024).toFixed(0)} KB`),
      )
    }))
  }
}

// --- Router --------------------------------------------------------------------
async function loadSession() {
  try { session = await api('/me') } catch { session = null }
  const who = document.getElementById('whoami')
  who.hidden = !session
  if (session) document.getElementById('username').textContent = `${session.user.name}${session.user.role === 'admin' ? ' (admin)' : ''}`
}

async function render() {
  document.title = 'ESSTRAPIS · Tiquets'
  if (!session) return renderLogin()
  const m = location.hash.match(/^#\/issue\/(\d+)$/)
  try {
    if (m) await renderIssue(m[1])
    else await renderHome()
  } catch (err) {
    if (session) view.replaceChildren(el('section', { class: 'card' }, el('p', { class: 'error' }, err.message), el('a', { href: '#/' }, '← Tots els tiquets')))
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {})
  session = null
  document.getElementById('whoami').hidden = true
  location.hash = '#/'
  render()
})

window.addEventListener('hashchange', render)
loadSession().then(render)
