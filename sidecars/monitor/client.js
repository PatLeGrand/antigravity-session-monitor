(() => {
  const PORT = window.__SM_PORT__;
  if (!PORT) return;
  if (window.__SM_CLEANUP__) {
    try { window.__SM_CLEANUP__(); } catch (_) {}
  }

  const STYLE_ID = 'sm-desktop-style';
  const DRAWER_ID = 'sm-left-drawer';
  const POLL_MS = 2000;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .sm-bar-wrap { width: 100%; margin-bottom: 6px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
      .sm-bar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 10px; background: color-mix(in srgb, var(--card, #222326) 92%, #fff 4%); border: 1px solid color-mix(in srgb, var(--border, #3a3b3e) 65%, transparent); cursor: pointer; font-size: 12.5px; font-variant-numeric: tabular-nums; }
      .sm-bar:hover { background: color-mix(in srgb, var(--card, #28292d) 90%, #fff 7%); }
      .sm-segs { display: inline-flex; gap: 2.5px; align-items: center; }
      .sm-seg { width: 7px; height: 6px; transform: skewX(-20deg); border-radius: 1px; box-sizing: border-box; }
      .sm-seg.empty { border: 1.25px solid rgba(155,160,166,.5); }
      .sm-seg.low { background: #57ab5a; border: 1.25px solid #57ab5a; }
      .sm-seg.mid { background: #e3b341; border: 1.25px solid #e3b341; }
      .sm-seg.high { background: #f85149; border: 1.25px solid #f85149; }
      .sm-pct { font-weight: 600; }
      .sm-pct.low { color: #57ab5a; } .sm-pct.mid { color: #e3b341; } .sm-pct.high { color: #f85149; }
      .sm-muted { color: rgba(165,170,178,.9); }
      .sm-agents-pill { color: #e07a5f; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
      .sm-agents-pill.none { color: rgba(165,170,178,.7); font-weight: 400; }
      .sm-spacer { flex: 1; }
      .sm-open-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 5px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: inherit; font-size: 11px; cursor: pointer; }
      .sm-open-btn:hover { background: rgba(255,255,255,.14); }

      #${DRAWER_ID} {
        position: fixed; top: 36px; bottom: 0; left: 256px; width: 370px; z-index: 9999;
        background: var(--card, #18191c); color: var(--foreground, #e4e6eb);
        border-right: 1px solid var(--border, rgba(255,255,255,.1));
        box-shadow: 6px 0 24px rgba(0,0,0,.35);
        display: none; flex-direction: column;
        font-family: ui-monospace, "Google Sans Code", SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px; line-height: 1.45;
      }
      #${DRAWER_ID}.open { display: flex; }
      .sm-d-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border, rgba(255,255,255,.08)); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .sm-d-title { font-weight: 600; font-size: 13px; flex: 1; }
      .sm-d-sel { background: rgba(255,255,255,.07); color: inherit; border: 1px solid rgba(255,255,255,.14); border-radius: 4px; font-size: 11px; padding: 2px 5px; }
      .sm-d-close { background: none; border: none; color: rgba(180,185,192,.8); font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
      .sm-d-close:hover { color: #fff; }
      .sm-d-body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
      .sm-d-ctx-line { display: flex; align-items: center; gap: 8px; }
      .sm-d-ctx-sub { color: rgba(165,170,178,.88); font-size: 12px; margin-top: 4px; font-variant-numeric: tabular-nums; }
      .sm-sec-title { color: rgba(140,146,154,.85); font-size: 11.5px; margin-bottom: 4px; }
      .sm-list { display: flex; flex-direction: column; gap: 3px; }
      .sm-agent { padding: 2px 4px; border-radius: 4px; }
      .sm-agent-row { display: flex; align-items: baseline; gap: 6px; }
      .sm-agent-name { font-weight: 600; color: var(--foreground, #eef0f4); }
      .sm-agent-dur { color: rgba(155,160,168,.85); font-variant-numeric: tabular-nums; }
      .sm-agent-act { color: rgba(165,170,178,.85); padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sm-file, .sm-act { display: flex; align-items: baseline; gap: 6px; overflow: hidden; white-space: nowrap; }
      .sm-act-txt { overflow: hidden; text-overflow: ellipsis; color: rgba(210,214,220,.92); }
      .sm-file-name { overflow: hidden; text-overflow: ellipsis; color: rgba(210,214,220,.92); }
      .sm-ic-work { color: #e07a5f; }
      .sm-ic-ok { color: #57ab5a; }
      .sm-ic-err { color: #f85149; }
      .sm-ic-add { color: #57ab5a; font-weight: 700; }
      .sm-ic-edit { color: #e3b341; font-weight: 700; }
      .sm-resize { position: absolute; top: 0; right: -3px; width: 6px; height: 100%; cursor: ew-resize; }
      .sm-resize:hover { background: rgba(88,166,255,.35); }
    `;
    document.head.appendChild(s);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));
  const fmtCost = (u) => Number(u || 0).toFixed(2).replace('.', ',') + '$';
  const fmtDur = (startIso, endIso, working) => {
    if (!startIso) return '';
    const t0 = new Date(startIso).getTime();
    const t1 = working ? Date.now() : (endIso ? new Date(endIso).getTime() : Date.now());
    const sec = Math.max(0, Math.round((t1 - t0) / 1000));
    if (sec < 60) return `${sec} s`;
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m} min ${s} s` : `${m} min`;
  };

  function getMaxTokens() {
    const v = Number(localStorage.getItem('sm.limit'));
    return [128000, 200000, 400000, 1000000, 2000000].includes(v) ? v : 200000;
  }

  function currentConvId() {
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (m) return m[1];
    const box = document.querySelector('[data-testid="agent-input-box"]');
    if (!box) return null;
    const fk = Object.keys(box).find((k) => k.startsWith('__reactFiber$'));
    let cur = fk ? box[fk] : null;
    for (let i = 0; cur && i < 40; i++, cur = cur.return) {
      const p = cur.memoizedProps;
      const id = p?.cascadeId || p?.conversationId || p?.cascadeContext?.state?.agentStateProvider?.getState?.()?.conversationId;
      if (id) return id;
    }
    return null;
  }

  function segsHtml(pct, total = 8) {
    const filled = pct <= 0 ? 0 : Math.max(1, Math.min(total, Math.round((pct / 100) * total)));
    const lvl = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
    let h = '<span class="sm-segs">';
    for (let i = 0; i < total; i++) h += `<span class="sm-seg ${i < filled ? lvl : 'empty'}"></span>`;
    return h + '</span>';
  }

  // Left drawer
  let drawer = document.getElementById(DRAWER_ID);
  if (!drawer) {
    drawer = document.createElement('aside');
    drawer.id = DRAWER_ID;
    const savedW = Number(localStorage.getItem('sm.drawerW'));
    if (savedW >= 260 && savedW <= 700) drawer.style.width = `${savedW}px`;
    drawer.innerHTML = `
      <div class="sm-d-head">
        <span class="sm-d-title">Session Monitor</span>
        <select class="sm-d-sel" id="sm-d-limit">
          <option value="128000">128k</option>
          <option value="200000">200k</option>
          <option value="400000">400k</option>
          <option value="1000000">1M</option>
          <option value="2000000">2M</option>
        </select>
        <button class="sm-d-close" title="Fermer">×</button>
      </div>
      <div class="sm-d-body" id="sm-d-body"></div>
      <div class="sm-resize" id="sm-resize"></div>
    `;
    document.body.appendChild(drawer);
    const sel = drawer.querySelector('#sm-d-limit');
    sel.value = String(getMaxTokens());
    sel.addEventListener('change', () => { localStorage.setItem('sm.limit', sel.value); renderAll(); });
    drawer.querySelector('.sm-d-close').addEventListener('click', () => setOpen(false));

    // Drag resize
    const handle = drawer.querySelector('#sm-resize');
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = drawer.getBoundingClientRect().width;
      const move = (ev) => {
        const w = Math.max(260, Math.min(700, startW + (ev.clientX - startX)));
        drawer.style.width = `${w}px`;
      };
      const up = () => {
        localStorage.setItem('sm.drawerW', String(Math.round(drawer.getBoundingClientRect().width)));
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  function positionDrawer() {
    const view = document.querySelector('[data-testid="overview-panel-host"]');
    const r = view?.getBoundingClientRect();
    drawer.style.left = r && r.left > 0 ? `${Math.round(r.left)}px` : '0px';
    drawer.style.top = r && r.top > 0 ? `${Math.round(r.top)}px` : '36px';
  }

  function setOpen(v) {
    positionDrawer();
    drawer.classList.toggle('open', v);
    localStorage.setItem('sm.open', v ? '1' : '0');
    if (v) renderAll();
  }
  if (localStorage.getItem('sm.open') === '1') setOpen(true);

  window.__SM_TOGGLE_LEFT__ = (force) => setOpen(typeof force === 'boolean' ? force : !drawer.classList.contains('open'));

  let lastData = null;
  let lastConv = null;
  let etag = '';

  function renderDrawer(d) {
    const body = drawer.querySelector('#sm-d-body');
    if (!d || !d.found) {
      body.innerHTML = '<div class="sm-muted">En attente de données pour cette session…</div>';
      return;
    }
    const max = getMaxTokens();
    const cur = d.context.current;
    const pct = Math.min(100, Math.round((cur / max) * 100));
    const lvl = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';

    const agentsHtml = d.subagents.length ? d.subagents.map((a) => {
      const work = a.state === 'working' || a.state === 'starting';
      const err = a.state === 'error' || a.state === 'killed';
      const ic = work ? '<span class="sm-ic-work">◐</span>' : err ? '<span class="sm-ic-err">✕</span>' : '<span class="sm-ic-ok">✓</span>';
      const dur = fmtDur(a.startedAt, a.lastAt, work);
      return `<div class="sm-agent">
        <div class="sm-agent-row">${ic}<span class="sm-agent-name">${esc(a.role)}</span><span class="sm-agent-dur">${esc(dur)}</span></div>
        ${a.activity && work ? `<div class="sm-agent-act">${esc(a.activity)}</div>` : ''}
      </div>`;
    }).join('') : '<div class="sm-muted">aucun</div>';

    const filesHtml = d.files?.length ? d.files.slice(0, 14).map((f) =>
      `<div class="sm-file" title="${esc(f.path)}">${f.kind === 'add' ? '<span class="sm-ic-add">+</span>' : '<span class="sm-ic-edit">~</span>'}<span class="sm-file-name">${esc(f.name)}</span></div>`
    ).join('') : '<div class="sm-muted">aucun</div>';

    const actHtml = d.recent?.length ? d.recent.slice(0, 16).map((r) => {
      const ic = r.status === 'ERROR' ? '<span class="sm-ic-err">✕</span>' : (r.status === 'RUNNING' || r.status === 'PENDING') ? '<span class="sm-ic-work">◐</span>' : '<span class="sm-ic-ok">✓</span>';
      return `<div class="sm-act">${ic}<span class="sm-act-txt">${esc(r.short || r.name)}${r.label ? ' ' + esc(r.label) : ''}</span></div>`;
    }).join('') : '<div class="sm-muted">aucune</div>';

    body.innerHTML = `
      <div>
        <div class="sm-d-ctx-line">${segsHtml(pct, 16)} <span class="sm-pct ${lvl}">${pct}%</span></div>
        <div class="sm-d-ctx-sub">${fmtK(cur)}/${fmtK(max)} · ${fmtCost(d.totals.costUsd)} · pic ${fmtK(d.context.peak)} · ${d.totals.calls} appels</div>
      </div>
      <div><div class="sm-sec-title">agents</div><div class="sm-list">${agentsHtml}</div></div>
      <div><div class="sm-sec-title">fichiers</div><div class="sm-list">${filesHtml}</div></div>
      <div><div class="sm-sec-title">activité</div><div class="sm-list">${actHtml}</div></div>
    `;
  }

  function renderBars(d) {
    const max = getMaxTokens();
    const cur = d?.found ? d.context.current : 0;
    const pct = Math.min(100, Math.round((cur / max) * 100));
    const lvl = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
    const working = d?.subagentStats?.working || 0;
    const total = d?.subagentStats?.total || 0;
    const agentsTxt = working > 0
      ? `<span class="sm-agents-pill">◐ ${working} agent${working > 1 ? 's' : ''}</span>`
      : total > 0
        ? `<span class="sm-agents-pill none">✓ ${total} agent${total > 1 ? 's' : ''}</span>`
        : `<span class="sm-agents-pill none">0 agent</span>`;

    document.querySelectorAll('.sm-bar').forEach((bar) => {
      bar.innerHTML = `
        ${segsHtml(pct, 8)}
        <span class="sm-pct ${lvl}">${pct}%</span>
        <span class="sm-muted">· ${fmtK(cur)} · ${fmtCost(d?.totals?.costUsd)} ·</span>
        ${agentsTxt}
        <span class="sm-spacer"></span>
        <button class="sm-open-btn" title="Ouvrir le moniteur à gauche en plus grand">◧ Panneau</button>
      `;
    });
  }

  function renderAll() {
    renderBars(lastData);
    if (drawer.classList.contains('open')) renderDrawer(lastData);
  }

  function attachBars() {
    injectStyles();
    document.querySelectorAll('[data-testid="agent-input-box"]').forEach((box) => {
      if (box.querySelector('.sm-bar-wrap') || !box.firstElementChild) return;
      const wrap = document.createElement('div');
      wrap.className = 'sm-bar-wrap';
      const bar = document.createElement('div');
      bar.className = 'sm-bar';
      bar.addEventListener('click', (e) => {
        e.stopPropagation();
        window.__SM_TOGGLE_LEFT__();
      });
      wrap.appendChild(bar);
      box.insertBefore(wrap, box.firstElementChild);
      renderBars(lastData);
    });
  }

  async function poll() {
    attachBars();
    const c = currentConvId();
    if (!c) return;
    if (c !== lastConv) { lastConv = c; etag = ''; lastData = null; }
    try {
      const q = new URLSearchParams({ conversationId: c, etag });
      const res = await fetch(`http://127.0.0.1:${PORT}/api/session?${q}`);
      if (!res.ok) return;
      const d = await res.json();
      if (!d.unchanged) {
        etag = d.etag || '';
        lastData = d;
      }
      renderAll();
    } catch (_) {}
  }

  poll();
  const pollId = setInterval(poll, POLL_MS);
  window.__SM_CLEANUP__ = () => {
    clearInterval(pollId);
    document.querySelectorAll('.sm-bar-wrap').forEach((e) => e.remove());
    document.getElementById(DRAWER_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
})();
