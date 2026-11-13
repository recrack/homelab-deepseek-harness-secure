import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './preset-guard.mjs'

function fixture() {
  let guard
  let mode = 'workspace-write'
  let plan
  let disposed = false
  const ctx = {
    tools: { guard(fn) { guard = fn; return () => { disposed = true } } },
    sandboxPolicy: { resolve: () => ({ mode }) },
    get: () => plan === undefined ? undefined : { get: () => plan },
    effect(fn) { this.dispose = fn() },
  }
  apply(ctx, { allowedTools: ['read', 'subagent_hermes', 'send_message', 'wait_agent'] })
  return { ctx, run: (name, agent = { session: {} }) => guard({ name, agent }),
    mode: value => { mode = value }, plan: value => { plan = value }, disposed: () => disposed }
}

test('coordinator permits reads and waits but denies direct execution, mutation and plugin changes', () => {
  const f = fixture()
  for (const name of ['read', 'wait_agent']) assert.equal(f.run(name), undefined)
  for (const name of ['bash', 'write', 'edit', 'apply_patch', 'plugin_manager', 'unexpected']) assert.ok(f.run(name))
})

test('each delegation checks the current policy, including messages that can resume work', () => {
  const f = fixture()
  for (const name of ['subagent_hermes', 'send_message']) {
    f.mode('workspace-write'); assert.equal(f.run(name), undefined)
    f.mode('read-only'); assert.ok(f.run(name))
    f.mode('danger-full-access'); assert.equal(f.run(name), undefined)
    assert.ok(f.run(name, null))
  }
})

test('active and pending plan selections fail closed; pending exit is honored', () => {
  const f = fixture()
  for (const plan of [{ active: true }, { active: false, pending: true }]) {
    f.plan(plan); assert.ok(f.run('subagent_hermes')); assert.ok(f.run('send_message'))
  }
  f.plan({ active: true, pending: false }); assert.equal(f.run('subagent_hermes'), undefined)
})

test('invalid configuration fails at activation and scope disposal removes the guard', () => {
  for (const config of [{}, { allowedTools: [''] }, { allowedTools: [1] }]) assert.throws(() => apply({}, config), TypeError)
  const f = fixture(); f.ctx.dispose(); assert.equal(f.disposed(), true)
})
