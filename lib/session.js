const crypto = require('crypto')
const config = require('./config')
const users = require('./users')

const COOKIE = 'tickets_session'

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url')
}

// `t`: the tenant this session came in from (SSO). A person with the same
// e-mail in several instances has one user here; each session sees the
// tickets of its own instance only (issues/402).
function createToken(user, tenant) {
  const payload = Buffer.from(JSON.stringify({
    u: user.username,
    v: user.tokenVersion || 0,
    ...(tenant ? { t: tenant } : {}),
    exp: Date.now() + config.sessionHours * 3600 * 1000,
  })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [payload, mac] = token.split('.')
  const expected = sign(payload)
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  let data
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()) } catch { return null }
  if (!data || data.exp < Date.now()) return null
  const user = users.find(data.u)
  // tokenVersion changes on password change / disable, which invalidates old cookies.
  if (!user || user.disabled || (user.tokenVersion || 0) !== data.v) return null
  // an SSO session is about the instance it came from, whatever the user's latest one
  return data.t ? { ...user, tenant: data.t } : user
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function cookieAttrs(maxAgeSec) {
  return [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAgeSec}`, config.production ? 'Secure' : ''].filter(Boolean).join('; ')
}

function setSession(res, user, tenant) {
  res.setHeader('Set-Cookie', `${COOKIE}=${createToken(user, tenant)}; ${cookieAttrs(config.sessionHours * 3600)}`)
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`)
}

function sessionMiddleware(req, res, next) {
  req.user = readToken(parseCookies(req.headers.cookie)[COOKIE])
  next()
}

module.exports = { createToken, readToken, setSession, clearSession, sessionMiddleware }
