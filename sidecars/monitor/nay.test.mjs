import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverNayCalls, readNayNodes } from './nay.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TIME = Date.parse('2026-11-19T12:00:00Z');
const at = (seconds = 0) => new Date(TIME + seconds * 1000).toISOString();
const event = (kind, seconds = 0, extra = {}) => ({ kind, callId: ID, ts: at(seconds), ...extra });
const launch = (root, verb = 'run', extra = {}) => ({
  type: 'PLANNER_RESPONSE', created_at: at(),
  tool_calls: [{ name: 'run_command', args: { CommandLine: `node "${root}/bin/nay.js" ${verb} sol`, ...extra } }],
});

function fixture(t, events = []) {
  const root = mkdtempSync(join(tmpdir(), 'monitor nay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.nay', 'state', 'events');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, '2026-11-19.jsonl');
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { root, file };
}

test('detects run, story and resume, quoted paths/args and fallback root', () => {
  for (const verb of ['run', 'story', 'resume']) {
    const step = launch('/tmp/nay root', verb);
    step.tool_calls[0].args.CommandLine = JSON.stringify(step.tool_calls[0].args.CommandLine);
    const refs = discoverNayCalls([step]);
    assert.equal(refs.launches[0].nayRoot, '/tmp/nay root');
    assert.equal(refs.launches[0].createdAt, at());
  }
  const step = launch('/unused');
  step.tool_calls[0].args.CommandLine = 'node bin/nay.js run sol';
  assert.equal(discoverNayCalls([step], { fallbackRoot: '/tmp/fallback' }).launches[0].nayRoot, '/tmp/fallback');
  step.tool_calls[0].args.CommandLine = 'node /tmp/bin/nay.js status';
  assert.deepEqual(discoverNayCalls([step]).launches, []);
  step.tool_calls[0].name = 'invoke_subagent';
  step.tool_calls[0].args.CommandLine = 'node /tmp/bin/nay.js run sol';
  assert.deepEqual(discoverNayCalls([step]).launches, []);
});

test('correlates an ongoing call by time and builds the app node', (t) => {
  const { root, file } = fixture(t, [
    event('call_start', 2, { agent: 'sol', role: 'coder', model: 'test-model' }),
    event('message', 3, { text: 'Je travaille\nsur le code' }),
    event('tool_start', 4, { tool: { name: 'Read', target: 'main.mjs' } }),
    event('usage', 5, { usage: { input: 42 } }),
  ]);
  appendFileSync(file, '{invalid JSON}\n{"kind":');
  const refs = discoverNayCalls([launch(root)]);
  assert.deepEqual(readNayNodes(refs, { now: TIME + 6000 }), [{
    id: ID, role: 'coder', type: 'nay', model: 'test-model', prompt: '',
    startedAt: at(2), lastAt: at(5), state: 'working', steps: 4,
    context: 42, peak: 42, toolCalls: 1, activity: 'Read main.mjs', children: [],
  }]);
  assert.equal(readNayNodes(refs, { now: TIME + 10000, staleMs: 1000 })[0].state, 'stale');
});

test('correlates finished calls by run_command output and refreshes live logs', (t) => {
  const { root, file } = fixture(t, [event('call_start'), event('usage', 1, { usage: { total: 12 } })]);
  const refs = discoverNayCalls([
    launch(root), { type: 'GENERIC', content: `Résultat : callId : ${ID}` },
  ]);
  assert.deepEqual(refs.knownIds, [ID]);
  assert.equal(readNayNodes(refs, { now: TIME + 2000 })[0].state, 'working');
  appendFileSync(file, JSON.stringify(event('call_end', 3, { status: 'ok', usage: { total: 99 } })) + '\n');
  const [node] = readNayNodes(refs, { now: TIME + 10000000 });
  assert.equal(node.state, 'idle');
  assert.equal(node.context, 99);
  assert.equal(node.peak, 99);
  assert.equal(node.steps, 3);
});

test('SYSTEM_MESSAGE IDs include finished errors using the fallback root', (t) => {
  const { root } = fixture(t, [
    event('call_start', -500, { agent: 'reviewer' }),
    event('message', -499, { text: 'Erreur\nexpliquée' }),
    event('usage', -498, { usage: { total: 25 } }),
    event('call_end', -497, { status: 'timeout' }),
  ]);
  const refs = discoverNayCalls([{ type: 'SYSTEM_MESSAGE', content: `callId: ${ID}` }], { fallbackRoot: root });
  const [node] = readNayNodes(refs);
  assert.equal(node.state, 'error');
  assert.equal(node.role, 'reviewer');
  assert.equal(node.context, 25);
  assert.equal(node.activity, 'Erreur expliquée');
});

test('excludes other conversations, unreferenced finished calls and user-quoted IDs', (t) => {
  const { root } = fixture(t, [
    event('call_start', -6),
    event('call_start', 121, { callId: OTHER }),
    event('call_start', 1, { callId: 'finished' }),
    event('call_end', 2, { callId: 'finished', status: 'ok' }),
  ]);
  const refs = discoverNayCalls([launch(root), { type: 'USER_INPUT', content: `callId: ${ID}` }]);
  assert.deepEqual(readNayNodes(refs), []);
  assert.deepEqual(readNayNodes(discoverNayCalls([], { fallbackRoot: root })), []);
});

test('an explicit launch ID prevents time matching another concurrent call', (t) => {
  const { root } = fixture(t, [event('call_start'), event('call_start', 1, { callId: OTHER })]);
  const refs = discoverNayCalls([launch(root), { type: 'GENERIC', content: `callId: ${ID}` }]);
  assert.deepEqual(readNayNodes(refs, { now: TIME + 2000 }).map((node) => node.id), [ID]);
});

test('matches run_command results in tool order alongside native subagents', (t) => {
  const { root } = fixture(t, [event('call_start'), event('call_end', 1, { status: 'error' })]);
  const step = launch(root);
  step.tool_calls.unshift({ name: 'invoke_subagent', args: {} });
  const refs = discoverNayCalls([
    step,
    { type: 'GENERIC', content: `conversationId: ${OTHER}` },
    { type: 'GENERIC', content: `callId: ${ID}` },
  ]);
  assert.deepEqual(refs.knownIds, [ID]);
  assert.deepEqual(refs.launches[0].callIds, [ID]);
  assert.equal(readNayNodes(refs)[0].state, 'error');
});

test('missing event directories and malformed events are harmless', () => {
  const refs = discoverNayCalls([launch('/no/such/nay-root')]);
  assert.deepEqual(readNayNodes(refs), []);
});
