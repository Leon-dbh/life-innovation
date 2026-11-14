#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'life-innovation-smoke-'))

function windowsNpmCli() {
  if (process.env.npm_execpath && process.env.npm_execpath.endsWith('.js')) return process.env.npm_execpath
  const where = spawnSync('where', ['npm'], { encoding: 'utf8' })
  const npmCmd = (where.stdout || '').split(/\r?\n/).find(Boolean)
  if (!npmCmd) return null
  const cli = path.join(path.dirname(npmCmd), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(cli) ? cli : null
}

const winNpmCli = process.platform === 'win32' ? windowsNpmCli() : null

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function runNpm(args, options = {}) {
  if (winNpmCli) return run(process.execPath, [winNpmCli, ...args], options)
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32',
  })
}

try {
  const packDir = path.join(tmp, 'pack')
  const consumerDir = path.join(tmp, 'consumer')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(consumerDir, { recursive: true })

  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', packDir], { cwd: root }))
  const filename = packed[0]?.filename
  if (!filename) throw new Error('npm pack did not report a tarball filename')
  const tarball = path.join(packDir, filename)
  const size = statSync(tarball).size

  const consumerPkg = {
    name: 'life-innovation-smoke',
    private: true,
    version: '0.0.0',
    type: 'module',
  }
  writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify(consumerPkg, null, 2) + '\n')

  runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarball,
  ], { cwd: consumerDir })

  const code = `
import fs from 'node:fs'
const installed = JSON.parse(fs.readFileSync('node_modules/life-innovation/package.json', 'utf8'))
const plugin = await import('life-innovation')
if (installed.version !== ${JSON.stringify(pkg.version)}) throw new Error('installed version ' + installed.version)
if (!plugin.apply || !plugin.inject) throw new Error('missing apply/inject exports')
console.log(JSON.stringify({ version: installed.version, exports: Object.keys(plugin).sort() }))
`
  const output = run(process.execPath, ['--input-type=module', '-e', code], { cwd: consumerDir, shell: false })
  console.log(`OK: package smoke ${pkg.name}@${pkg.version} (${size} bytes) ${output.trim()}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
