const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Write to a temp file and rename, so readers never see a half-written file.
function writeFileAtomic(file, content, mode = 0o640) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
}

// Serialises async tasks (single process), so issue ids and edits never race.
function createLock() {
  let tail = Promise.resolve()
  return (fn) => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }
}

module.exports = { writeFileAtomic, createLock }
