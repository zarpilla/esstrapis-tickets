#!/usr/bin/env node
// User management from the server shell (there is no sign-up page on purpose).
//   npm run user -- add <username> "<Full name>" [user|admin]   (asks for the password)
//   npm run user -- passwd <username>
//   npm run user -- role <username> <user|admin>
//   npm run user -- disable|enable <username>
//   npm run user -- list
const readline = require('readline')
const users = require('../lib/users')

function askPassword(prompt) {
  if (process.env.TICKETS_PASSWORD) return Promise.resolve(process.env.TICKETS_PASSWORD)
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s) } // hide typed chars
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer) })
  })
}

async function main() {
  const [cmd, username, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'add': {
      const [name, role = 'user'] = rest
      if (users.find(username)) throw new Error(`User ${username} already exists`)
      const password = await askPassword('Password (min 10 chars): ')
      users.upsert({ username, name, role, password })
      console.log(`Created ${role} ${username}`)
      break
    }
    case 'passwd': {
      if (!users.find(username)) throw new Error(`No user ${username}`)
      users.upsert({ username, password: await askPassword('New password (min 10 chars): ') })
      console.log(`Password changed for ${username} (existing sessions logged out)`)
      break
    }
    case 'role':
      if (!users.find(username)) throw new Error(`No user ${username}`)
      users.upsert({ username, role: rest[0] })
      console.log(`${username} is now ${rest[0]}`)
      break
    case 'disable':
    case 'enable':
      users.setDisabled(username, cmd === 'disable')
      console.log(`${username} ${cmd}d`)
      break
    case 'list':
      for (const u of users.load()) console.log(`${u.username.padEnd(20)} ${u.role.padEnd(6)} ${u.disabled ? 'disabled' : 'active  '} ${u.name}`)
      break
    default:
      console.log('Usage: npm run user -- add|passwd|role|disable|enable|list ...  (see scripts/user.js)')
      process.exitCode = 1
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
