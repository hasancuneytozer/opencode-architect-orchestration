import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DEFAULT_LOOP_CONFIG, loadLoopConfig, waitForIteration} from '../plugins/orchestra/loop.ts'

test('default and configured zero do not impose an elapsed iteration deadline', async t => {
  assert.equal(DEFAULT_LOOP_CONFIG.idleTimeoutMs, 0)
  const root = await mkdtemp(join(tmpdir(), 'orchestra-wait-policy-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  await mkdir(join(root, '.opencode'))
  await writeFile(join(root, '.opencode/orchestra.json'), JSON.stringify({loop: {idleTimeoutMs: 0}}))
  assert.equal((await loadLoopConfig(root)).idleTimeoutMs, 0)
})

test('zero timeout waits for actual completion and still observes explicit stop', async () => {
  let status = 'running'
  const memory = {syncStore: async () => {}, getLoop: () => ({status, runID: 'r'})}
  const ctx = {session: {wait: () => new Promise(() => {})}}
  const stop = setTimeout(() => {status = 'stopped'}, 40)
  try {
    assert.equal(await waitForIteration(ctx, memory, 's', {
      idleTimeoutMs: 0, maxWallClockMs: 0, stopPollMs: 5, runID: 'r',
    }), 'stopped')
  } finally { clearTimeout(stop) }
})

test('explicit opt-in timeout and actual session failures remain distinguishable', async () => {
  const memory = {syncStore: async () => {}, getLoop: () => ({status: 'running', runID: 'r'})}
  const options = {idleTimeoutMs: 10, maxWallClockMs: 0, stopPollMs: 5, runID: 'r'}
  assert.equal(await waitForIteration({session: {wait: () => new Promise(() => {})}}, memory, 's', options), 'timeout')
  assert.equal(await waitForIteration({session: {wait: async () => {throw new Error('session closed')}}}, memory, 's', {...options, idleTimeoutMs: 0}), 'broken')
})
