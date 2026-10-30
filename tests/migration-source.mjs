import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const directory = new URL('../migrations/', import.meta.url)
export async function migrationNames() {
  const files = (await readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/.test(item.name)).map(item => item.name).sort()
  assert.ok(files.length >= 3, 'versioned migrations must include the current schema')
  assert.equal(new Set(files.map(file => file.slice(0, 4))).size, files.length, 'duplicate migration number')
  return files
}
export async function migrationSql(selected) {
  const names = await migrationNames()
  const files = selected ?? names
  assert.deepEqual(files, names.slice(0, files.length), 'only ordered migration prefixes are allowed for upgrade tests')
  return (await Promise.all(files.map(file => readFile(new URL(file, directory), 'utf8')))).join('\n')
}
