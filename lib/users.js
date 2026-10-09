const crypto = require('crypto')
const fs = require('fs')
const config = require('./config')
const { writeFileAtomic } = require('./fsutil')

// A plain name (e.g. jordi) or an email address (users with an email get notifications).
const USERNAME_RE = /^(?=.{2,100}$)[a-z0-9._+-]+(@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})?$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isEmail = (username) => EMAIL_RE.test(username)
const ROLES = ['user', 'admin']

function load() {
  if (!fs.existsSync(config.usersFile)) return []
  return JSON.parse(fs.readFileSync(config.usersFile, 'utf8'))
}

function save(users) {
  writeFileAtomic(config.usersFile, JSON.stringify(users, null, 2) + '\n', 0o600)
}

function find(username) {
  return load().find((u) => u.username === username) || null
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

// Hash used when the user doesn't exist, so login takes the same time either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'))

function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || DUMMY_HASH).split('$')
  if (scheme !== 'scrypt') return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 })
  return crypto.timingSafeEqual(expected, actual)
}

function authenticate(username, password) {
  const user = find(String(username || '').toLowerCase())
  const ok = verifyPassword(password, user && user.hash)
  return ok && user && !user.disabled ? user : null
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('Password must have at least 10 characters')
}

function upsert({ username, name, role, password }) {
  username = String(username || '').toLowerCase()
  if (!USERNAME_RE.test(username)) throw new Error('Username: an email address, or 2-100 chars of lowercase letters, digits, . _ + -')
  if (role && !ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`)
  const users = load()
  let user = users.find((u) => u.username === username)
  if (!user) {
    if (!password) throw new Error('A new user needs a password')
    user = { username, name: name || username, role: role || 'user', tokenVersion: 0 }
    users.push(user)
  }
  if (name) user.name = name
  if (role) user.role = role
  if (password) {
    validatePassword(password)
    user.hash = hashPassword(password)
    user.tokenVersion = (user.tokenVersion || 0) + 1 // logs out existing sessions
  }
  save(users)
  return user
}

// Sign-in from an ESSTRAPIS instance. Creates the user on first visit, linked to
// that tenant. An existing account is only accepted when it belongs to the same
// tenant and isn't an admin, so an instance can't sign in as someone else's user
// or as an admin of this site.
function ssoLogin({ email, name, tenant }) {
  const username = String(email || '').trim().toLowerCase()
  if (!USERNAME_RE.test(username) || !isEmail(username)) throw new Error('invalid email')
  const cleanName = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) : ''
  const users = load()
  let user = users.find((u) => u.username === username)
  if (user) {
    if (user.disabled) throw new Error('user disabled')
    if (user.role === 'admin') throw new Error('admins must log in with a password')
    if (user.tenant !== tenant) throw new Error(`user belongs to tenant ${user.tenant || '(none)'}`)
    if (cleanName && cleanName !== user.name) { user.name = cleanName; save(users) }
    return user
  }
  user = { username, name: cleanName || username, role: 'user', tenant, tokenVersion: 0, created: new Date().toISOString() }
  users.push(user)
  save(users)
  return user
}

function setDisabled(username, disabled) {
  const users = load()
  const user = users.find((u) => u.username === username)
  if (!user) throw new Error(`No user ${username}`)
  user.disabled = disabled
  user.tokenVersion = (user.tokenVersion || 0) + 1
  save(users)
}

function publicUser(u) {
  return { username: u.username, name: u.name, role: u.role, tenant: u.tenant || null }
}

module.exports = { isEmail, load, find, authenticate, upsert, ssoLogin, setDisabled, publicUser, ROLES }
