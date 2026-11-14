#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testsDir = path.join(root, 'tests')
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='))
const timeoutArg = process.argv.find((arg) => arg.startsWith('--timeout='))
const only = onlyArg ? onlyArg.slice('--only='.length) : ''
const timeout = timeoutArg ? Number(timeoutArg.slice('--timeout='.length)) : 120_000

if (!Number.isFinite(timeout) || timeout <= 0) {
  console.error('test-runner: --timeout must be a positive number of milliseconds')
  process.exit(2)
}

const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => !only || name.includes(only))
  .sort()

if (!files.length) {
  console.error(only ? `test-runner: no test files matched ${only}` : 'test-runner: no test files found')
  process.exit(2)
}

const started = Date.now()
const failures = []

for (const [index, name] of files.entries()) {
  const file = path.join('tests', name)
  const label = `[${index + 1}/${files.length}] ${name}`
  const begin = Date.now()
  console.log(`\n> ${label}`)
  const result = spawnSync(process.execPath, [file], {
    cwd: root,
    stdio: 'inherit',
    timeout,
    killSignal: 'SIGTERM',
  })
  const elapsed = Date.now() - begin
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? `timed out after ${timeout}ms` : result.error.message
    console.error(`FAIL ${name} (${reason})`)
    failures.push({ name, reason })
    continue
  }
  if (result.status !== 0) {
    const reason = result.signal ? `terminated by ${result.signal}` : `exit ${result.status}`
    console.error(`FAIL ${name} (${reason}, ${elapsed}ms)`)
    failures.push({ name, reason })
    continue
  }
  console.log(`ok ${name} (${elapsed}ms)`)
}

const totalMs = Date.now() - started
console.log(`\n${files.length - failures.length}/${files.length} test files passed in ${totalMs}ms`)
if (failures.length) {
  console.error('failed:')
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.reason}`)
  process.exitCode = 1
}
