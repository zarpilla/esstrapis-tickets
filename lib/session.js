const crypto = require('crypto')
const config = require('./config')
const users = require('./users')

const COOKIE = 'tickets_session'

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url')
}

function createToken(user) {
  const payload = Buffer.from(JSON.stringify({
    u: user.username,
    v: user.tokenVersion || 0,
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
  return user
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

function setSession(res, user) {
  res.setHeader('Set-Cookie', `${COOKIE}=${createToken(user)}; ${cookieAttrs(config.sessionHours * 3600)}`)
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`)
}

function sessionMiddleware(req, res, next) {
  req.user = readToken(parseCookies(req.headers.cookie)[COOKIE])
  next()
}

module.exports = { createToken, readToken, setSession, clearSession, sessionMiddleware }
