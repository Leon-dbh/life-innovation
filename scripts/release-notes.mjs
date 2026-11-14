#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(2)
}

const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replace(/^\uFEFF/, '')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const heading = new RegExp(`^##\\s*(?:\\[)?v?${escaped}(?:\\])?\\s*(?:—|-|:)?.*$`, 'm')
const match = heading.exec(changelog)
if (!match) {
  console.log(`Release v${version}\n\nSee CHANGELOG.md for details.`)
  process.exit(0)
}

const start = match.index + match[0].length
const rest = changelog.slice(start)
const next = /^##\s/m.exec(rest)
const body = (next ? rest.slice(0, next.index) : rest).trim()
console.log(body || `Release v${version}`)
