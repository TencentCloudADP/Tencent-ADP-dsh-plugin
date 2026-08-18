import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REFS = ['ADP_API_KEY', 'ADP_SECRET_ID', 'ADP_SECRET_KEY'] as const

/** Fill live-test env from `$DSH_HOME/.credentials.yaml` when the process has no values. */
export function loadDshCredentials(): void {
  if (REFS.every((name) => process.env[name]?.trim())) return
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  let text = ''
  try {
    text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  } catch {
    return
  }
  for (const name of REFS) {
    if (process.env[name]?.trim()) continue
    const match = text.match(new RegExp(`^${name}:\\s*(.+)\\s*$`, 'm'))
    const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    if (value) process.env[name] = value
  }
}

loadDshCredentials()
