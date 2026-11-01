// issues/404 (security review round 3, 2026-11-01): every ESSTRAPIS instance
// held the same SSO key, so reading one instance's environment let anyone sign
// in as anyone of any instance. Each instance now holds tenantSecret(master,
// tenant) and puts its tenant in front of the token.
const { test } = require('node:test')
const assert = require('node:assert')
const sso = require('../lib/sso')

const MASTER = 'master-key-master-key-master-key-0123456789'
const make = (secret, tenant, prefix = tenant) => `${prefix}.${sso.createToken({ secret, tenant, tenantName: tenant, email: 'a@coop.cat', name: 'A' })}`

test("an instance's own key works for its tenant only", () => {
  const own = sso.tenantSecret(MASTER, 'coop-a')
  assert.strictEqual(sso.readInstanceToken({ master: MASTER, token: make(own, 'coop-a') }).tenant, 'coop-a')
  // coop-a's key can't make a token for coop-b, under either name
  assert.throws(() => sso.readInstanceToken({ master: MASTER, token: make(own, 'coop-b'), sharedKeyAllowed: false }))
  assert.throws(() => sso.readInstanceToken({ master: MASTER, token: make(own, 'coop-b', 'coop-a') }), /mismatch/)
  assert.notStrictEqual(own, sso.tenantSecret(MASTER, 'coop-b'))
})

test('the shared key still works while allowed, then not', () => {
  assert.strictEqual(sso.readInstanceToken({ master: MASTER, token: make(MASTER, 'coop-a') }).tenant, 'coop-a')
  const bare = sso.createToken({ secret: MASTER, tenant: 'coop-a', tenantName: 'A', email: 'a@coop.cat', name: 'A' })
  assert.strictEqual(sso.readInstanceToken({ master: MASTER, token: bare }).tenant, 'coop-a')
  assert.throws(() => sso.readInstanceToken({ master: MASTER, token: make(MASTER, 'coop-a'), sharedKeyAllowed: false }))
  assert.throws(() => sso.readInstanceToken({ master: MASTER, token: bare, sharedKeyAllowed: false }), /without instance/)
})

test('a bad tenant in front is refused', () => {
  assert.throws(() => sso.readInstanceToken({ master: MASTER, token: make(MASTER, 'coop-a', '../x') }), /invalid tenant/)
})
