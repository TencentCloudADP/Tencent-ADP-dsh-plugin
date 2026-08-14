import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const dest = resolve(root, 'lib/client.js')
const candidates = [resolve(root, 'lib/client.cjs'), dest]

const src = candidates.find((path) => existsSync(path))
if (!src) {
  throw new Error('tsdown client bundle missing (expected lib/client.cjs or lib/client.js)')
}

const body = readFileSync(src, 'utf8')
if (body.startsWith('window.__ModuleLoader__.load')) {
  if (src !== dest) {
    writeFileSync(dest, body)
    unlinkSync(src)
  }
  process.exit(0)
}

const wrapped = `window.__ModuleLoader__.load({
  id: "@tencent/dsh-adp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  }
});
`

writeFileSync(dest, wrapped)
if (src !== dest) unlinkSync(src)
