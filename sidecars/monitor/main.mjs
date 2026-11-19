/**
 * Session Monitor sidecar backend.
 *
 * Reads, read-only, the compact transcript of the pane's conversation:
 *   <appData>/brain/<conv>/.system_generated/logs/transcript.jsonl
 * One JSON step per line. PLANNER_RESPONSE steps carry input_tokens,
 * cache_read_tokens, output_tokens and tool_calls [{name, args}] (string args
 * are JSON-quoted). Tool results follow as GENERIC steps, in call order.
 *
 * Also injects the compact status bar + left-docked monitor panel into
 * Antigravity Desktop via DevToolsActivePort (if available).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONV_ID_RE = /"conversationId"\s*:\s*"([0-9a-f-]{36})"/gi;
const MAX_DEPTH = 3;
const STALE_MS = 15 * 60 * 1000;
const RECENT_TOOLS = 40;

const STATIC = {
  '/app.js': ['app.js', 'application/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
  '/client.js': ['client.js', 'application/javascript'],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-sidecar-token',
};

// ---------------------------------------------------------------------------
// App data dirs
// ---------------------------------------------------------------------------

function appDataDirs() {
  const out = [];
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') { out.push(dirname(d)); break; }
    }
  }
  const root = join(homedir(), '.gemini');
  let names = [];
  try { names = readdirSync(root); } catch { /* none */ }
  for (const n of names.sort()) {
    const p = join(root, n);
    if (!out.includes(p) && existsSync(join(p, 'brain'))) out.push(p);
  }
  return out;
}

const transcriptPath = (appData, conv, full = false) =>
  join(appData, 'brain', conv, '.system_generated', 'logs', full ? 'transcript_full.jsonl' : 'transcript.jsonl');

function locate(conv) {
  for (const a of appDataDirs()) if (existsSync(transcriptPath(a, conv))) return a;
  return null;
}

function statOf(p) {
  try { const s = statSync(p); return { mtime: s.mtimeMs, size: s.size }; } catch { return { mtime: 0, size: -1 }; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : v;
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === '[' && s.endsWith(']')) || (s[0] === '{' && s.endsWith('}')))) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return s;
}

function oneLine(s, max = 90) {
  const out = String(s || '').replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const SHORT_TOOL = {
  view_file: 'Read',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  edit_file: 'Edit',
  run_command: 'Bash',
  invoke_subagent: 'Subagent',
  manage_subagents: 'Subagents',
  search_web: 'Web',
  read_url_content: 'Fetch',
};

function labelOf(tc) {
  const name = tc?.name || '';
  const a = tc?.args && typeof tc.args === 'object' ? tc.args : {};
  const path = unquote(a.AbsolutePath || a.TargetFile || a.Path);
  if (typeof path === 'string' && path) return basename(path);
  const cmd = unquote(a.CommandLine);
  if (typeof cmd === 'string' && cmd) return oneLine(cmd, 56);
  const summary = unquote(a.toolSummary) || unquote(a.toolAction);
  if (typeof summary === 'string' && summary) return oneLine(summary, 56);
  return name.startsWith('mcp__') ? '' : '';
}

function parseSpecs(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  let s = v.trim();
  for (let k = 0; k < 2 && typeof s === 'string'; k++) {
    const clean = s.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    try { s = JSON.parse(clean); } catch { break; }
    if (Array.isArray(s)) return s;
  }
  const text = typeof v === 'string' ? v : '';
  const str = '"((?:[^"\\\\]|\\\\.)*)"';
  return text.split(/\{\s*"/).slice(1).map((chunk) => {
    const get = (k) => {
      const m = new RegExp(`(?:^|")${k}"?\\s*:\\s*${str}`).exec(chunk);
      if (!m) return '';
      try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
    };
    return { Role: get('Role'), TypeName: get('TypeName'), Model: get('Model'), Prompt: get('Prompt') };
  });
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const s = JSON.parse(line); if (s && typeof s === 'object') out.push(s); } catch { /* torn line */ }
  }
  return out;
}

function resultsAfter(steps, i, n) {
  const res = [];
  for (let j = i + 1; j < steps.length && res.length < n; j++) {
    const t = steps[j].type;
    if (t === 'PLANNER_RESPONSE' || t === 'USER_INPUT') break;
    if (t === 'GENERIC') res.push(steps[j]);
  }
  return res;
}

function turnState(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === 'ERROR_MESSAGE') return 'error';
    if (s.type === 'PLANNER_RESPONSE') {
      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      return calls.length === 0 ? 'idle' : 'working';
    }
    if (s.type === 'USER_INPUT' || s.type === 'GENERIC' || s.type === 'SYSTEM_MESSAGE') return 'working';
  }
  return 'idle';
}

// ---------------------------------------------------------------------------
// Transcript summary (cached on mtime+size)
// ---------------------------------------------------------------------------

const cache = new Map();

function summarize(appData, conv) {
  const path = transcriptPath(appData, conv);
  const st = statOf(path);
  if (st.size < 0) return null;
  const key = `${st.mtime}:${st.size}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.sum;

  let text;
  try { text = readFileSync(path, 'utf-8'); } catch { return null; }
  const steps = parseLines(text);
  let fullSteps = null;
  const full = () => {
    if (!fullSteps) {
      try { fullSteps = parseLines(readFileSync(transcriptPath(appData, conv, true), 'utf-8')); } catch { fullSteps = []; }
    }
    return fullSteps;
  };

  const history = [];
  const tools = new Map();
  const files = new Map(); // path -> {path, name, kind: 'add'|'edit', t}
  const recent = [];
  const subs = new Map();
  const killed = new Set();
  let totals = { input: 0, cacheRead: 0, output: 0, calls: 0, userTurns: 0, costUsd: 0 };
  let activity = '';
  let firstAt = null;
  let lastAt = null;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.created_at) { lastAt = s.created_at; if (!firstAt) firstAt = s.created_at; }
    if (s.type === 'USER_INPUT') totals.userTurns++;
    if (s.type !== 'PLANNER_RESPONSE') continue;

    const inp = Number(s.input_tokens) || 0;
    const cr = Number(s.cache_read_tokens) || 0;
    const outp = Number(s.output_tokens) || 0;
    const ctx = inp + cr;
    if (inp || cr) history.push({ i: s.step_index ?? i, ctx, out: outp, t: s.created_at });
    totals.input += inp; totals.cacheRead += cr; totals.output += outp; totals.calls++;
    const high = ctx > 200_000;
    totals.costUsd += (inp / 1e6) * (high ? 2.5 : 1.25) + (cr / 1e6) * (high ? 0.625 : 0.3125) + (outp / 1e6) * (high ? 15 : 10);

    const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
    if (!calls.length) continue;
    const results = resultsAfter(steps, i, calls.length);
    calls.forEach((tc, k) => {
      const name = tc?.name || '?';
      const r = results[k];
      const status = r ? String(r.status || '') : 'PENDING';
      const t = tools.get(name) || { name, count: 0, errors: 0, last: null };
      t.count++;
      if (status === 'ERROR') t.errors++;
      t.last = s.created_at || t.last;
      tools.set(name, t);

      const label = labelOf(tc);
      recent.push({
        step: s.step_index ?? i,
        name,
        short: SHORT_TOOL[name] || name,
        label,
        status,
        t: s.created_at,
      });
      if (label) activity = `${SHORT_TOOL[name] || name} ${label}`;

      // Track created / modified files.
      if (name === 'write_to_file' || name === 'replace_file_content' || name === 'multi_replace_file_content' || name === 'edit_file') {
        const fp = unquote(tc.args?.TargetFile || tc.args?.AbsolutePath || tc.args?.Path);
        if (typeof fp === 'string' && fp && status !== 'ERROR') {
          const prev = files.get(fp);
          const kind = name === 'write_to_file' && !prev ? 'add' : (prev?.kind || 'edit');
          files.delete(fp);
          files.set(fp, { path: fp, name: basename(fp), kind, t: s.created_at });
        }
      }

      if (name === 'invoke_subagent') {
        let specs = parseSpecs(tc.args?.Subagents);
        if (Array.isArray(s.truncated_fields) && s.truncated_fields.includes('tool_calls')) {
          const fs = full().find((x) => x.step_index === s.step_index);
          const ftc = fs?.tool_calls?.[k];
          if (ftc?.name === 'invoke_subagent') specs = parseSpecs(ftc.args?.Subagents);
        }
        let content = r ? String(r.content || '') : '';
        if (r && Array.isArray(r.truncated_fields) && r.truncated_fields.includes('content')) {
          const f = full().find((x) => x.step_index === r.step_index);
          if (f) content = String(f.content || '');
        }
        const ids = [...content.matchAll(CONV_ID_RE)].map((m) => m[1]);
        ids.forEach((id, n) => {
          const sp = specs[n] || {};
          subs.set(id, {
            role: sp.Role || sp.TypeName || 'subagent',
            type: sp.TypeName || '',
            model: sp.Model || '',
            prompt: oneLine(sp.Prompt || '', 160),
            startedAt: s.created_at,
          });
        });
      } else if (name === 'manage_subagents') {
        const action = unquote(tc.args?.Action);
        if (action === 'kill') {
          const ids = unquote(tc.args?.ConversationIds);
          if (Array.isArray(ids)) ids.forEach((x) => killed.add(x));
        } else if (action === 'kill_all') {
          for (const id of subs.keys()) killed.add(id);
        }
      }
    });
  }

  const last = history[history.length - 1];
  let state = turnState(steps);
  if (state === 'working' && Date.now() - st.mtime > STALE_MS) state = 'stale';

  const sum = {
    conv,
    steps: steps.length ? (steps[steps.length - 1].step_index ?? steps.length - 1) + 1 : 0,
    state,
    activity,
    mtime: st.mtime,
    firstAt,
    lastAt,
    context: {
      current: last ? last.ctx : 0,
      peak: history.reduce((m, h) => Math.max(m, h.ctx), 0),
      history: downsample(history, 160),
    },
    totals,
    files: [...files.values()].reverse(),
    tools: [...tools.values()].sort((a, b) => b.count - a.count),
    recent: recent.slice(-RECENT_TOOLS).reverse(),
    subs: [...subs.entries()].map(([id, m]) => ({ id, ...m, killed: killed.has(id) })),
  };
  if (cache.size > 300) cache.clear();
  cache.set(path, { key, sum });
  return sum;
}

function downsample(arr, n) {
  if (arr.length <= n) return arr.map((h) => [h.i, h.ctx]);
  const out = [];
  const step = arr.length / n;
  for (let k = 0; k < n; k++) out.push([arr[Math.floor(k * step)].i, arr[Math.floor(k * step)].ctx]);
  const l = arr[arr.length - 1];
  out.push([l.i, l.ctx]);
  return out;
}

function subTree(appData, sum, depth, seen) {
  if (!sum || depth > MAX_DEPTH) return [];
  return sum.subs.map((s) => {
    if (seen.has(s.id)) return null;
    seen.add(s.id);
    const a = existsSync(transcriptPath(appData, s.id)) ? appData : locate(s.id);
    const c = a ? summarize(a, s.id) : null;
    let state = c ? c.state : 'starting';
    if (s.killed) state = 'killed';
    return {
      id: s.id,
      role: s.role,
      type: s.type,
      model: s.model,
      prompt: s.prompt,
      startedAt: c?.firstAt || s.startedAt,
      lastAt: c?.lastAt || null,
      state,
      steps: c?.steps || 0,
      context: c?.context.current || 0,
      peak: c?.context.peak || 0,
      toolCalls: c ? c.tools.reduce((n, t) => n + t.count, 0) : 0,
      activity: c?.activity || '',
      children: c && a ? subTree(a, c, depth + 1, seen) : [],
    };
  }).filter(Boolean);
}

function flatten(tree, out = []) {
  for (const n of tree) { out.push(n); flatten(n.children, out); }
  return out;
}

// ---------------------------------------------------------------------------
// CDP injection into Antigravity Desktop (optional, best-effort)
// ---------------------------------------------------------------------------

const PORT_FILE =
  process.env.AGY_BROWSER_ACTIVE_PORT_FILE ||
  join(homedir(), '.config', 'Antigravity', 'DevToolsActivePort');
const SIDECAR_PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
const injected = new Set();

function devToolsPort() {
  try {
    const p = Number(readFileSync(PORT_FILE, 'utf-8').split('\n')[0].trim());
    return p > 0 ? p : null;
  } catch { return null; }
}

function evalInTarget(wsUrl, expression) {
  return new Promise((resolve) => {
    let ws, done = false;
    const finish = (v) => {
      if (done) return; done = true; clearTimeout(t);
      try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch { /* ignore */ }
      resolve(v);
    };
    const t = setTimeout(() => finish(false), 2000);
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
      ws.onmessage = (e) => {
        try { if (JSON.parse(e.data).id === 1) finish(true); } catch { finish(false); }
      };
      ws.onerror = () => finish(false);
      ws.onclose = () => finish(false);
    } catch { finish(false); }
  });
}

async function pollCdp() {
  if (!SIDECAR_PORT) return;
  const port = devToolsPort();
  if (!port) return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const targets = await res.json();
    const live = new Set();
    for (const t of targets) {
      if (t.type !== 'page' || !t.webSocketDebuggerUrl || String(t.url || '').startsWith('devtools://')) continue;
      live.add(t.id);
      if (injected.has(t.id)) continue;
      const script = readFileSync(join(__dirname, 'client.js'), 'utf-8');
      const ok = await evalInTarget(t.webSocketDebuggerUrl, `window.__SM_PORT__=${SIDECAR_PORT};\n${script}`);
      if (ok) injected.add(t.id);
    }
    for (const id of injected) if (!live.has(id)) injected.delete(id);
  } catch { /* ignore */ }
}

async function toggleLeftViaCdp() {
  const port = devToolsPort();
  if (!port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const targets = await res.json();
    let hit = false;
    for (const t of targets) {
      if (t.type !== 'page' || !t.webSocketDebuggerUrl || String(t.url || '').startsWith('devtools://')) continue;
      const ok = await evalInTarget(t.webSocketDebuggerUrl, 'window.__SM_TOGGLE_LEFT__ && window.__SM_TOGGLE_LEFT__(true)');
      if (ok) hit = true;
    }
    return hit;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
for (const [route, [file, type]] of Object.entries(STATIC)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type, headers: CORS }), 'GET');
}

app.api('/api/session', (data) => {
  const conv = data.conversationId || app.config.conversationId || '';
  if (!conv || !ID_RE.test(conv)) return new Response(JSON.stringify({ conversationId: conv || null, found: false }), { contentType: 'application/json', headers: CORS });
  const appData = locate(conv);
  if (!appData) return new Response(JSON.stringify({ conversationId: conv, found: false }), { contentType: 'application/json', headers: CORS });
  const sum = summarize(appData, conv);
  if (!sum) return new Response(JSON.stringify({ conversationId: conv, found: false }), { contentType: 'application/json', headers: CORS });
  const tree = subTree(appData, sum, 1, new Set([conv]));
  const flat = flatten(tree);
  const etag = [sum.mtime, ...flat.map((n) => `${n.id}:${n.state}:${n.steps}`)].join('|');
  const body = data.etag && data.etag === etag
    ? { conversationId: conv, found: true, unchanged: true, etag }
    : (() => {
        const { subs, ...rest } = sum;
        return {
          conversationId: conv,
          found: true,
          etag,
          ...rest,
          subagents: tree,
          subagentStats: {
            total: flat.length,
            working: flat.filter((n) => n.state === 'working' || n.state === 'starting').length,
          },
        };
      })();
  return new Response(JSON.stringify(body), { contentType: 'application/json', headers: CORS });
}, 'GET');

app.api('/api/toggle-left', async () => {
  const ok = await toggleLeftViaCdp();
  return new Response(JSON.stringify({ ok }), { contentType: 'application/json', headers: CORS });
}, 'GET');

app.run().then(() => {
  pollCdp();
  setInterval(pollCdp, 5000);
});
