#!/usr/bin/env node
// ESSTRAPIS instances (tenants) allowed to sign users in through /sso.
//   npm run tenant -- add <tenant> ["<Name>"]       creates it and prints its API key (store it in the instance)
//   npm run tenant -- rotate <tenant>              new API key (the old one stops working)
//   npm run tenant -- disable|enable <tenant>
//   npm run tenant -- list
//   npm run tenant -- token <tenant> <email> ["<Full name>"] [ttlSeconds]   prints a test login URL
const config = require('../lib/config')
const tenants = require('../lib/tenants')
const sso = require('../lib/sso')

function main() {
  const [cmd, tenant, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'add': {
      const t = tenants.add(tenant, rest[0])
      console.log(`Created tenant ${t.tenant}. API key (keep it secret, set it in the ESSTRAPIS instance):\n${t.apiKey}`)
      break
    }
    case 'rotate':
      console.log(`New API key for ${tenant}:\n${tenants.rotate(tenant).apiKey}`)
      break
    case 'disable':
    case 'enable':
      tenants.setDisabled(tenant, cmd === 'disable')
      console.log(`${tenant} ${cmd}d`)
      break
    case 'list':
      for (const t of tenants.load()) console.log(`${t.tenant.padEnd(24)} ${t.disabled ? 'disabled' : 'active  '} ${t.name}`)
      break
    case 'token': {
      const [email, name, ttl] = rest
      const t = tenants.find(tenant)
      if (!t) throw new Error(`No active tenant ${tenant}`)
      if (!email) throw new Error('Usage: token <tenant> <email> ["<Full name>"] [ttlSeconds]')
      const ttlSec = Math.min(Number(ttl) || 300, sso.MAX_LIFETIME_SEC)
      const token = sso.createToken({ tenant: t.tenant, apiKey: t.apiKey, email, name, ttlSec })
      const base = config.publicUrl || `http://localhost:${config.port}`
      console.log(`${base}/sso?tenant=${encodeURIComponent(t.tenant)}&token=${token}`)
      console.error(`(valid ${ttlSec}s, single use)`)
      break
    }
    default:
      console.log('Usage: npm run tenant -- add|rotate|disable|enable|list|token ...  (see scripts/tenant.js)')
      process.exitCode = 1
  }
}

try { main() } catch (err) { console.error(err.message); process.exit(1) }
