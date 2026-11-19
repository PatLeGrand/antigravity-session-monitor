import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CALL_ID_RE = /\bcallId\s*:\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi;
const DEFAULT_STALE_MS = 15 * 60 * 1000;

function unquote(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function callIds(content) {
  return [...String(content || '').matchAll(CALL_ID_RE)].map((m) => m[1].toLowerCase());
}

// Keep transcript discovery separate from live event reads: the transcript can be cached.
export function discoverNayCalls(steps, {
  fallbackRoot = process.env.NAY_ROOT || join(homedir(), '.gemini', 'antigravity', 'scratch', 'nay-delegation'),
} = {}) {
  const launches = [];
  const knownIds = new Set();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.type === 'SYSTEM_MESSAGE') callIds(step.content).forEach((id) => knownIds.add(id));
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const results = [];
    for (let j = i + 1; j < steps.length && results.length < calls.length; j++) {
      if (['PLANNER_RESPONSE', 'USER_INPUT'].includes(steps[j].type)) break;
      if (steps[j].type === 'GENERIC') results.push(steps[j]);
    }
    calls.forEach((call, k) => {
      if (call?.name !== 'run_command') return;
      const ids = callIds(results[k]?.content);
      ids.forEach((id) => knownIds.add(id));
      const args = unquote(call.args) || {};
      const command = unquote(args.CommandLine);
      if (typeof command !== 'string') return;
      const tokens = (command.match(/"[^"]*"|'[^']*'|[^\s;&|]+/g) || [])
        .map((token) => token.replace(/^(['"])(.*)\1$/, '$2'));
      for (let n = 0; n < tokens.length - 1; n++) {
        if (!/(?:^|\/)bin\/nay\.js$/.test(tokens[n]) || !/^(run|story|resume)$/.test(tokens[n + 1])) continue;
        const prefix = tokens[n].slice(0, -'bin/nay.js'.length);
        const nayRoot = prefix ? resolve(unquote(args.Cwd) || process.cwd(), prefix) : fallbackRoot;
        launches.push({ nayRoot, createdAt: step.created_at, callIds: ids });
      }
    });
  }
  return { launches, knownIds: [...knownIds], fallbackRoot };
}

function readEvents(root) {
  const directory = join(root, '.nay', 'state', 'events');
  let files;
  try { files = readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort(); } catch { return []; }
  const events = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(directory, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (typeof event?.callId === 'string' && Number.isFinite(Date.parse(event.ts))) events.push(event);
      } catch { /* Ignore invalid or partially written lines. */ }
    }
  }
  return events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

export function readNayNodes(refs, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  const known = new Set(refs.knownIds);
  const roots = new Set(refs.launches.map((launch) => launch.nayRoot));
  if (known.size) roots.add(refs.fallbackRoot);
  const nodes = new Map();
  for (const root of roots) {
    const calls = new Map();
    for (const event of readEvents(root)) {
      const id = event.callId.toLowerCase();
      if (!calls.has(id)) calls.set(id, []);
      calls.get(id).push(event);
    }
    for (const [id, events] of calls) {
      const start = events.find((event) => event.kind === 'call_start');
      const end = events.findLast((event) => event.kind === 'call_end');
      // Completed calls need an explicit ID. Time matching is only a fallback
      // while run_command has not yet returned its callId.
      const nearby = !end && start && refs.launches.some((launch) => {
        if (launch.nayRoot !== root || launch.callIds.length) return false;
        const delta = Date.parse(start.ts) - Date.parse(launch.createdAt);
        return delta >= -5000 && delta <= 120000;
      });
      if (!known.has(id) && !nearby) continue;
      const call = events.reduce((metadata, event) => Object.assign(metadata, event), {});
      const usage = end?.usage || events.findLast((event) => event.kind === 'usage')?.usage || {};
      const context = Number(usage.total || usage.input) || 0;
      const lastAt = events.at(-1).ts;
      const active = events.findLast((event) => event.kind === 'tool_start' || event.kind === 'message');
      const activity = active?.kind === 'tool_start'
        ? oneLine([active.tool?.name, active.tool?.target || active.target].filter(Boolean).join(' '))
        : oneLine(active?.text);
      nodes.set(id, {
        id, role: call.role || call.agent || 'nay', type: 'nay', model: call.model || '', prompt: '',
        startedAt: start?.ts || events[0].ts, lastAt,
        state: end ? (end.status === 'ok' ? 'idle' : 'error')
          : (now - Date.parse(lastAt) > staleMs ? 'stale' : 'working'),
        steps: events.length, context, peak: context,
        toolCalls: events.filter((event) => event.kind === 'tool_start').length,
        activity, children: [],
      });
    }
  }
  return [...nodes.values()];
}
