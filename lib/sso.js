// Single sign-on from ESSTRAPIS instances.
//
// All instances share one secret with this site (TICKETS_SSO_KEY on both sides).
// An instance encrypts { tenant, tenantName, email, name, exp, nonce } with
// AES-256-GCM, using a key derived from that secret, and sends the user to:
//
//   https://tiquets.esstrapis.org/sso?token=<token>
//
// token = base64url( iv[12] | ciphertext | authTag[16] ). The secret never travels:
// a token that decrypts proves it was made by an instance holding the secret, so
// its tenant and user are trusted. Unknown tenants are registered on first use.
// Tokens are short-lived (max 10 min) and single-use.
const crypto = require('crypto')

const MAX_LIFETIME_SEC = 600
const CLOCK_SKEW_SEC = 60
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/
const AAD = Buffer.from('esstrapis-tickets-sso/v2', 'utf8')

// Tenant name from an ESSTRAPIS instance name ("Fusteria La Serra, SCCL" ->
// "fusteria-la-serra-sccl"). Must stay identical to tenantSlug() in
// projectes-v5 src/services/tickets-sso.js.
function tenantSlug(name) {
  return String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .slice(0, 63).replace(/^-+|-+$/g, '')
}

function deriveKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'esstrapis-tickets-sso', 'v2', 32))
}

// Reference implementation for the ESSTRAPIS side (see scripts/tenant.js token).
function createToken({ secret, tenant, tenantName, email, name, ttlSec = 300 }) {
  const payload = {
    tenant,
    tenantName,
    email,
    name,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    nonce: crypto.randomBytes(16).toString('base64url'),
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv)
  cipher.setAAD(AAD)
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64url')
}

// Returns the payload, or throws with a reason (for logs; never shown to users).
function readToken({ secret, token }) {
  const raw = Buffer.from(String(token || ''), 'base64url')
  if (raw.length < 12 + 16 + 2 || raw.length > 4096) throw new Error('bad token size')
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), raw.subarray(0, 12))
  decipher.setAAD(AAD)
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  let payload
  try {
    payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'))
  } catch {
    throw new Error('token does not decrypt with the SSO key')
  }
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(payload.exp) || payload.exp < now - CLOCK_SKEW_SEC) throw new Error('token expired')
  if (payload.exp > now + MAX_LIFETIME_SEC + CLOCK_SKEW_SEC) throw new Error('token lifetime too long')
  if (typeof payload.nonce !== 'string' || payload.nonce.length < 16) throw new Error('missing nonce')
  if (typeof payload.tenant !== 'string' || !TENANT_RE.test(payload.tenant)) throw new Error('invalid tenant')
  return payload
}

// Remembers used nonces until their token expires (single process), to stop replays.
const usedNonces = new Map()
function consumeNonce(nonce, exp) {
  const now = Math.floor(Date.now() / 1000)
  for (const [n, e] of usedNonces) if (e < now - CLOCK_SKEW_SEC) usedNonces.delete(n)
  if (usedNonces.has(nonce)) return false
  usedNonces.set(nonce, exp)
  return true
}

module.exports = { TENANT_RE, tenantSlug, MAX_LIFETIME_SEC, createToken, readToken, consumeNonce }
