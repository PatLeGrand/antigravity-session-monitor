/* Session Monitor frontend: polls /api/session for the pane's conversation. */
(() => {
  const POLL_MS = 2000;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';
  const sfetch = (u) => (window.sidecar?.fetch ? window.sidecar.fetch(u) : fetch(u));

  const STATE_LABEL = {
    working: 'En cours', starting: 'Démarrage', idle: 'Terminé / en attente',
    error: 'Erreur', stale: 'Inactif (bloqué ?)', killed: 'Arrêté',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n || 0));
  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `il y a ${Math.round(s)}s`;
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    return `il y a ${Math.round(s / 3600)} h`;
  };

  // Context limit, remembered per browser.
  const limitSel = $('limit');
  limitSel.value = localStorage.getItem('sm.limit') || '200000';
  limitSel.addEventListener('change', () => { localStorage.setItem('sm.limit', limitSel.value); if (last) render(last); });

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    $('tools-agg').classList.toggle('hidden', b.dataset.tab !== 'tools-agg');
    $('tools-recent').classList.toggle('hidden', b.dataset.tab !== 'tools-recent');
  }));

  let last = null;
  let etag = '';
  let conv = null;
  let lastOk = 0;

  $('open-left').addEventListener('click', () => sfetch('/api/toggle-left').catch(() => {}));

  function renderContext(d) {
    const limit = Number(limitSel.value);
    const cur = d.context.current;
    const pct = Math.min(100, (cur / limit) * 100);
    $('ctx-now').textContent = cur.toLocaleString();
    $('ctx-limit').textContent = fmtK(limit);
    $('ctx-pct').textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
    const bar = $('ctx-bar');
    bar.style.width = `${pct}%`;
    bar.className = 'bar-fill' + (pct >= 85 ? ' danger' : pct >= 60 ? ' warn' : '');
    $('ctx-peak').textContent = fmtK(d.context.peak);
    $('calls').textContent = d.totals.calls;
    $('out').textContent = fmtK(d.totals.output);
    $('cost').textContent = Number(d.totals.costUsd || 0).toFixed(2).replace('.', ',') + '$';

    // Sparkline of context size per model call.
    const h = d.context.history;
    const svg = $('spark');
    if (h.length < 2) { svg.innerHTML = ''; return; }
    const max = Math.max(limit, ...h.map((p) => p[1])) * 1.02;
    const W = 300, H = 48;
    const pts = h.map((p, k) => [(k / (h.length - 1)) * W, H - (p[1] / max) * H]);
    const line = pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
    const ly = (H - (limit / max) * H).toFixed(1);
    svg.innerHTML =
      `<polygon class="area" points="0,${H} ${line} ${W},${H}"/>` +
      `<polyline class="line" points="${line}"/>` +
      `<line class="limitline" x1="0" x2="${W}" y1="${ly}" y2="${ly}"/>`;
  }

  function renderFiles(d) {
    const list = d.files || [];
    $('files-badge').textContent = String(list.length);
    $('files').innerHTML = list.length
      ? list.slice(0, 14).map((f) => `<div class="file-row" title="${esc(f.path)}"><span class="${f.kind}">${f.kind === 'add' ? '+' : '~'}</span><span class="fn">${esc(f.name)}</span></div>`).join('')
      : '<div class="none">Aucun fichier modifié.</div>';
  }

  function subHtml(n) {
    const canOpen = !!window.sidecar?.ui?.toggleConversation;
    const meta = [
      n.model && n.model !== 'inherit' ? n.model : '',
      `${n.steps} étapes`,
      `${n.toolCalls} outils`,
      `ctx ${fmtK(n.context)}`,
      n.lastAt ? ago(n.lastAt) : '',
    ].filter(Boolean).join(' · ');
    return `<div class="sub${canOpen ? ' clickable' : ''}" data-conv="${esc(n.id)}" title="${esc(n.prompt || n.id)}${canOpen ? '\n\nCliquer pour ouvrir la conversation' : ''}">
      <div class="sub-row"><span class="dot ${esc(n.state)}"></span><span class="sub-role">${esc(n.role)}</span><span class="sub-state">${esc(STATE_LABEL[n.state] || n.state)}</span></div>
      <div class="sub-meta">${esc(meta)}</div>
      ${n.activity && (n.state === 'working' || n.state === 'starting') ? `<div class="sub-act">↳ ${esc(n.activity)}</div>` : ''}
      ${n.children?.length ? `<div class="sub-children">${n.children.map(subHtml).join('')}</div>` : ''}
    </div>`;
  }

  function renderSubs(d) {
    const st = d.subagentStats;
    const badge = $('sub-badge');
    badge.textContent = st.working ? `${st.working} actif${st.working > 1 ? 's' : ''} / ${st.total}` : String(st.total);
    badge.classList.toggle('on', st.working > 0);
    $('subs').innerHTML = d.subagents.length
      ? d.subagents.map(subHtml).join('')
      : '<div class="none">Aucun sous-agent lancé dans cette session.</div>';
  }

  function renderTools(d) {
    const max = Math.max(1, ...d.tools.map((t) => t.count));
    $('tools-agg').innerHTML = d.tools.length
      ? d.tools.map((t) => `<div class="tool" title="Dernier appel : ${esc(fmtTime(t.last))}">
          <span class="tool-name">${esc(t.name)}</span>
          <div class="tool-bar"><div style="width:${(t.count / max) * 100}%"></div></div>
          <span class="tool-n">${t.count}${t.errors ? `<span class="e">✕${t.errors}</span>` : ''}</span>
        </div>`).join('')
      : '<div class="none">Aucun outil utilisé pour l’instant.</div>';
    $('tools-recent').innerHTML = d.recent.length
      ? d.recent.map((r) => `<div class="rc" title="${esc(r.status)}">
          <span class="st ${esc(r.status)}"></span>
          <span class="n">${esc(r.short || r.name)}</span>
          <span class="l">${esc(r.label)}</span>
          <span class="t">${esc(fmtTime(r.t))}</span>
        </div>`).join('')
      : '<div class="none">—</div>';
  }

  function render(d) {
    $('empty').classList.add('hidden');
    $('main').classList.remove('hidden');
    $('state-dot').className = `dot ${d.state}`;
    $('state-label').textContent = `Session : ${STATE_LABEL[d.state] || d.state}`;
    renderContext(d);
    renderSubs(d);
    renderFiles(d);
    renderTools(d);
  }

  $('subs').addEventListener('click', (e) => {
    const el = e.target.closest('.sub.clickable');
    if (el && window.sidecar?.ui?.toggleConversation) {
      e.stopPropagation();
      window.sidecar.ui.toggleConversation(el.dataset.conv);
    }
  });

  async function poll() {
    try {
      const c = currentConv();
      if (c !== conv) { conv = c; etag = ''; last = null; }
      const q = new URLSearchParams({ etag });
      if (c) q.set('conversationId', c);
      const res = await sfetch(`/api/session?${q}`);
      const d = await res.json();
      lastOk = Date.now();
      if (!d.found) {
        $('main').classList.add('hidden');
        $('empty').classList.remove('hidden');
        $('empty-sub').textContent = d.conversationId
          ? `Pas encore de transcript pour ${d.conversationId}.`
          : 'Ouvre ce panneau depuis une conversation.';
      } else if (!d.unchanged) {
        etag = d.etag;
        last = d;
        render(d);
      } else if (last) {
        renderSubs(last); // refresh relative times
      }
    } catch (e) {
      console.warn(e);
    } finally {
      $('live').classList.toggle('stale', Date.now() - lastOk > POLL_MS * 4);
      setTimeout(poll, POLL_MS);
    }
  }
  poll();
})();
