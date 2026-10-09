#!/usr/bin/env node
// ESSTRAPIS instances (tenants) that sign users in through /sso. They register
// themselves on first login; use this to list or block them.
//   npm run tenant -- list
//   npm run tenant -- disable|enable <tenant or "instance name">
//   npm run tenant -- token <tenant or "instance name"> <email> ["<Full name>"] [ttlSeconds]   prints a test login URL
const config = require('../lib/config')
const tenants = require('../lib/tenants')
const sso = require('../lib/sso')

function main() {
  const [cmd, tenant, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'list':
      for (const t of tenants.load()) {
        console.log(`${t.tenant.padEnd(32)} ${t.disabled ? 'disabled' : 'active  '} ${(t.lastLogin || '-').slice(0, 10)}  ${t.name}`)
      }
      break
    case 'disable':
    case 'enable': {
      const t = tenants.setDisabled(tenant, cmd === 'disable')
      console.log(`${t.tenant} ${cmd}d`)
      break
    }
    case 'token': {
      const [email, name, ttl] = rest
      if (!config.ssoKey) throw new Error('TICKETS_SSO_KEY is not set')
      if (!tenant || !email) throw new Error('Usage: token <tenant or "instance name"> <email> ["<Full name>"] [ttlSeconds]')
      const slug = tenants.resolve(tenant)
      const ttlSec = Math.min(Number(ttl) || 300, sso.MAX_LIFETIME_SEC)
      const token = sso.createToken({ secret: config.ssoKey, tenant: slug, tenantName: tenant, email, name, ttlSec })
      const base = config.publicUrl || `http://localhost:${config.port}`
      console.log(`${base}/sso?token=${token}`)
      console.error(`(tenant ${slug}, valid ${ttlSec}s, single use)`)
      break
    }
    default:
      console.log('Usage: npm run tenant -- list|disable|enable|token ...  (see scripts/tenant.js)')
      process.exitCode = 1
  }
}

try { main() } catch (err) { console.error(err.message); process.exit(1) }
