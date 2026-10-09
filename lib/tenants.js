// ESSTRAPIS instances allowed to sign users in (data/tenants.json, mode 600).
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const { writeFileAtomic } = require('./fsutil')
const { TENANT_RE } = require('./sso')

const file = () => path.join(config.dataDir, 'tenants.json')

function load() {
  if (!fs.existsSync(file())) return []
  return JSON.parse(fs.readFileSync(file(), 'utf8'))
}

function save(tenants) {
  writeFileAtomic(file(), JSON.stringify(tenants, null, 2) + '\n', 0o600)
}

function find(tenant) {
  return load().find((t) => t.tenant === tenant && !t.disabled) || null
}

function newKey() {
  return crypto.randomBytes(32).toString('base64url')
}

function add(tenant, name) {
  tenant = String(tenant || '').toLowerCase()
  if (!TENANT_RE.test(tenant)) throw new Error('Tenant: 2-63 chars, lowercase letters, digits, - _')
  const tenants = load()
  if (tenants.some((t) => t.tenant === tenant)) throw new Error(`Tenant ${tenant} already exists`)
  const entry = { tenant, name: name || tenant, apiKey: newKey(), created: new Date().toISOString() }
  tenants.push(entry)
  save(tenants)
  return entry
}

function rotate(tenant) {
  const tenants = load()
  const entry = tenants.find((t) => t.tenant === tenant)
  if (!entry) throw new Error(`No tenant ${tenant}`)
  entry.apiKey = newKey()
  save(tenants)
  return entry
}

function setDisabled(tenant, disabled) {
  const tenants = load()
  const entry = tenants.find((t) => t.tenant === tenant)
  if (!entry) throw new Error(`No tenant ${tenant}`)
  entry.disabled = disabled
  save(tenants)
}

module.exports = { load, find, add, rotate, setDisabled }
