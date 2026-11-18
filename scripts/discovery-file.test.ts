/**
 * Unit tests for scripts/discovery-file.ts, used by scripts/relay.ts.
 *
 * The bug this guards against: on Prodigy the container's root filesystem is
 * read-only (docker-compose.yml `read_only: true`), so writeDiscoveryFile's
 * mkdir/write failed with ENOENT/EROFS and crashed the whole server — even
 * though discovery files are only read by the VS Code extension's hook
 * forwarder and are never needed for a headless deployment.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { writeDiscoveryFile } from './discovery-file'
import { resolveDiscoveryDir } from '../extension/src/constants'

describe('resolveDiscoveryDir', () => {
  it('defaults to ~/.claude/agent-flow when AGENT_FLOW_DISCOVERY_DIR is unset', () => {
    assert.equal(resolveDiscoveryDir('/home/u', {}), path.join('/home/u', '.claude', 'agent-flow'))
  })

  it('uses AGENT_FLOW_DISCOVERY_DIR when set', () => {
    assert.equal(resolveDiscoveryDir('/home/u', { AGENT_FLOW_DISCOVERY_DIR: '/tmp/custom-dir' }), '/tmp/custom-dir')
  })

  it('ignores a blank AGENT_FLOW_DISCOVERY_DIR', () => {
    assert.equal(resolveDiscoveryDir('/home/u', { AGENT_FLOW_DISCOVERY_DIR: '  ' }), path.join('/home/u', '.claude', 'agent-flow'))
  })
})

describe('writeDiscoveryFile', () => {
  const dirsToClean: string[] = []
  after(() => {
    delete process.env.AGENT_FLOW_DISCOVERY_DIR
    for (const d of dirsToClean) fs.rmSync(d, { recursive: true, force: true })
  })

  it('creates missing nested parent directories (recursive mkdir)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-relay-'))
    dirsToClean.push(base)
    const dir = path.join(base, 'does', 'not', 'exist', 'yet')
    process.env.AGENT_FLOW_DISCOVERY_DIR = dir

    writeDiscoveryFile(4242, base)

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    assert.equal(files.length, 1)
    const written = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
    assert.equal(written.port, 4242)
    assert.equal(written.pid, process.pid)
  })

  it('does not throw when the discovery dir cannot be created (e.g. read-only fs)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-relay-'))
    dirsToClean.push(base)
    // A file where a directory is expected makes mkdir fail with ENOTDIR,
    // reproducing "can't create this path" without depending on running as
    // a non-root user (CI may run as root, where chmod-based perms are a
    // no-op).
    const blocked = path.join(base, 'blocked-file')
    fs.writeFileSync(blocked, 'not a directory')
    process.env.AGENT_FLOW_DISCOVERY_DIR = path.join(blocked, 'agent-flow')

    assert.doesNotThrow(() => writeDiscoveryFile(4242, base))
  })

  it('logs a warning instead of crashing on write failure', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-relay-'))
    dirsToClean.push(base)
    const blocked = path.join(base, 'blocked-file')
    fs.writeFileSync(blocked, 'not a directory')
    process.env.AGENT_FLOW_DISCOVERY_DIR = path.join(blocked, 'agent-flow')

    const originalWarn = console.warn
    let warned = false
    console.warn = () => { warned = true }
    try {
      writeDiscoveryFile(4242, base)
    } finally {
      console.warn = originalWarn
    }
    assert.equal(warned, true)
  })
})
