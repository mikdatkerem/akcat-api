import { migrationNames } from './migration-source.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

test('migration CLI: tracked 0001 -> 0002 upgrade; repeated apply is a data-preserving no-op', { timeout: 60000 }, async () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temporary = await mkdtemp(join(tmpdir(), 'akcat-migrations-audit-'))
  try {
    const config = JSON.parse(await readFile(join(project, 'tests/wrangler.jsonc'), 'utf8'))
    assert.equal(config.d1_databases[0].database_id, '11111111-1111-4111-8111-111111111111')
    assert.notEqual(config.d1_databases[0].remote, true)
    const migrations = join(temporary, 'migrations'); await mkdir(migrations)
    config.main = join(project, 'tests/worker.ts'); config.d1_databases[0].migrations_dir = migrations
    const configuration = join(temporary, 'wrangler.json'); await writeFile(configuration, JSON.stringify(config))
    async function cli(args) {
      const child = spawn(process.execPath, [join(project, 'node_modules/wrangler/bin/wrangler.js'), 'd1', ...args,
        '--config', configuration, '--local', '--persist-to', join(temporary, 'state')],
      { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } })
      let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.resume()
      assert.equal(await new Promise(done => child.once('exit', done)), 0, 'isolated migration CLI exit')
      return output
    }
    const name = config.d1_databases[0].database_name
    const state = async () => JSON.parse(await cli(['execute', name, '--json', '--command',
      "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name; SELECT id,name FROM d1_migrations ORDER BY id;"]))
    await writeFile(join(migrations, '0001_initial_schema.sql'), await readFile(join(project, 'migrations/0001_initial_schema.sql')))
    await cli(['migrations', 'apply', name]); const first = await state()
    assert.equal(first[1].results.length, 1); assert.equal(first[1].results[0].name, '0001_initial_schema.sql')
    await writeFile(join(migrations, '0002_financial_adjustments.sql'), await readFile(join(project, 'migrations/0002_financial_adjustments.sql')))
    for (const file of (await migrationNames()).slice(2)) await writeFile(join(migrations, file), await readFile(join(project, 'migrations', file)))
    await cli(['migrations', 'apply', name]); const upgraded = await state()
    assert.equal(upgraded[1].results.length, (await migrationNames()).length); assert.equal(upgraded[1].results[1].name, '0002_financial_adjustments.sql')
    assert.deepEqual(upgraded[1].results.map(row => row.name), await migrationNames())
    assert.ok(upgraded[0].results.some(row => row.name === 'financial_adjustments'))
    await cli(['migrations', 'apply', name]); const repeated = await state()
    assert.deepEqual(repeated.map(row => row.results), upgraded.map(row => row.results))
  } finally {
    const target = await realpath(temporary), parent = await realpath(tmpdir())
    assert.equal(dirname(target).toLowerCase(), parent.toLowerCase())
    assert.ok(target.toLowerCase().startsWith((parent + sep + 'akcat-migrations-audit-').toLowerCase()))
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})
