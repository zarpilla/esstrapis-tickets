// ESSTRAPIS instances seen through SSO (data/tenants.json). They register
// themselves on first login; this file lets an admin list or block them.
const fs = require('fs')
const path = require('path')
const config = require('./config')
const { writeFileAtomic } = require('./fsutil')
const { TENANT_RE, tenantSlug } = require('./sso')

const file = () => path.join(config.dataDir, 'tenants.json')

function load() {
  if (!fs.existsSync(file())) return []
  return JSON.parse(fs.readFileSync(file(), 'utf8'))
}

function save(tenants) {
  writeFileAtomic(file(), JSON.stringify(tenants, null, 2) + '\n', 0o600)
}

function find(tenant) {
  return load().find((t) => t.tenant === tenant) || null
}

// Accepts the tenant slug or the instance name as shown in ESSTRAPIS.
function resolve(tenantOrName) {
  const raw = String(tenantOrName || '').trim()
  return TENANT_RE.test(raw) ? raw : tenantSlug(raw)
}

// Called on every SSO login: registers a new tenant, refreshes its display name.
// Returns null when the tenant is blocked.
function seen(tenant, name) {
  if (!TENANT_RE.test(tenant)) throw new Error('invalid tenant')
  const cleanName = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) : ''
  const tenants = load()
  let entry = tenants.find((t) => t.tenant === tenant)
  if (entry && entry.disabled) return null
  const now = new Date().toISOString()
  if (!entry) {
    entry = { tenant, name: cleanName || tenant, created: now }
    tenants.push(entry)
  } else if (cleanName) {
    entry.name = cleanName
  }
  delete entry.apiKey // per-tenant keys are no longer used
  entry.lastLogin = now
  save(tenants)
  return entry
}

// Blocks (or unblocks) a tenant, creating the entry if it hasn't logged in yet.
function setDisabled(tenantOrName, disabled) {
  const tenant = resolve(tenantOrName)
  if (!TENANT_RE.test(tenant)) throw new Error(`Invalid tenant ${tenantOrName}`)
  const tenants = load()
  let entry = tenants.find((t) => t.tenant === tenant)
  if (!entry) {
    entry = { tenant, name: tenantOrName, created: new Date().toISOString() }
    tenants.push(entry)
  }
  entry.disabled = disabled
  save(tenants)
  return entry
}

module.exports = { load, find, resolve, seen, setDisabled }
