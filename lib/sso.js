// Single sign-on from ESSTRAPIS instances.
//
// Each instance ("tenant") shares a secret API key with this site. The instance
// encrypts { email, name, exp, nonce } with AES-256-GCM using a key derived from
// that secret, and sends the user to:
//
//   https://tiquets.esstrapis.org/sso?tenant=<tenant>&token=<token>
//
// token = base64url( iv[12] | ciphertext | authTag[16] ), with the tenant name as
// additional authenticated data. The API key never travels in the URL: a token
// that decrypts proves it was made by someone holding the tenant's key. Tokens are
// short-lived (max 10 min) and single-use.
const crypto = require('crypto')

const MAX_LIFETIME_SEC = 600
const CLOCK_SKEW_SEC = 60
const TENANT_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/

// Tenant name from an ESSTRAPIS instance name ("Fusteria La Serra, SCCL" ->
// "fusteria-la-serra-sccl"). Must stay identical to tenantSlug() in
// projectes-v5 src/services/tickets-sso.js, which signs with it.
function tenantSlug(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .slice(0, 63).replace(/^-+|-+$/g, '')
}

function deriveKey(apiKey, tenant) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(apiKey, 'utf8'), 'esstrapis-tickets-sso', tenant, 32))
}

// Reference implementation for the ESSTRAPIS side (see scripts/tenant.js token).
function createToken({ tenant, apiKey, email, name, ttlSec = 300 }) {
  const payload = {
    email,
    name,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    nonce: crypto.randomBytes(16).toString('base64url'),
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(apiKey, tenant), iv)
  cipher.setAAD(Buffer.from(tenant, 'utf8'))
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64url')
}

// Returns the payload, or throws with a reason (for logs; never shown to users).
function readToken({ tenant, apiKey, token }) {
  const raw = Buffer.from(String(token || ''), 'base64url')
  if (raw.length < 12 + 16 + 2 || raw.length > 4096) throw new Error('bad token size')
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(apiKey, tenant), raw.subarray(0, 12))
  decipher.setAAD(Buffer.from(tenant, 'utf8'))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  let payload
  try {
    payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'))
  } catch {
    throw new Error('token does not decrypt with this tenant key')
  }
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(payload.exp) || payload.exp < now - CLOCK_SKEW_SEC) throw new Error('token expired')
  if (payload.exp > now + MAX_LIFETIME_SEC + CLOCK_SKEW_SEC) throw new Error('token lifetime too long')
  if (typeof payload.nonce !== 'string' || payload.nonce.length < 16) throw new Error('missing nonce')
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
