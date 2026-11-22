// app.js — Launch Radar dashboard. Renders window.RADAR (written by main.ts
// from the sealed snapshot) and nothing else: no network, no framework.
// The verdicts recompute live from the deposit and drop-share controls;
// the model itself — fit, odds, ranges — is fixed by the snapshot.

const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function money(n) {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}
function usd(n) {
  const a = Math.abs(n);
  return (n < 0 ? '-$' : '$') + (a >= 100 ? Math.round(a).toLocaleString('en-US') : a.toFixed(2));
}
function ageStr(d) {
  if (d === null || d === undefined) return '—';
  if (d < 365) return Math.round(d / 30.4 * 10) / 10 + ' mo';
  return Math.round(d / 365.25 * 10) / 10 + ' yr';
}

/** Recompute one row's verdict under the reader's scenario. */
function verdictFor(r, depScale, dropShare) {
  const dep = r.deposit * depScale;
  const drop = r.implied * dropShare * (dep / Math.max(1, r.tvl));
  const fees = r.fees;
  const net = drop - fees;
  const tbill = dep * R.benchmarks.tbillApr * (R.benchmarks.horizonWeeks / 52);
  const netHour = net / r.hours;
  const v = net > tbill && netHour > R.benchmarks.hourRate ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { dep, drop, fees, net, tbill, netHour, v };
}

const state = { q: '', badge: '', verdict: '', sort: 'implied', dep: 1, drop: 0.07, tab: 'board' };

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let rows = R.rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    if (state.badge && !r.badges.includes(state.badge)) return false;
    const v = verdictFor(r, state.dep, state.drop);
    if (state.verdict && v.v !== state.verdict) return false;
    return true;
  });
  const key = state.sort;
  const val = (r) => key === 'tvl' ? r.tvl : key === 'odds' ? r.odds : key === 'age' ? (r.ageDays === null ? -1 : r.ageDays)
    : key === 'net' ? verdictFor(r, state.dep, state.drop).net : r.implied;
  rows = rows.slice().sort((a, b) => val(b) - val(a) || a.rank - b.rank);
  return rows;
}

function badgeHtml(r) {
  return r.badges.map((b) => `<span class="badge${b === 'Watchlist' ? ' wl' : b === 'Kin' ? ' kin' : ''}">${esc(b)}</span>`).join('');
}

function renderBoard() {
  const rows = visibleRows();
  const tb = $('rows');
  tb.innerHTML = rows.map((r) => {
    const v = verdictFor(r, state.dep, state.drop);
    return `<tr data-slug="${esc(r.slug)}"><td class="num">${r.rank}</td><td><b>${esc(r.name)}</b>${badgeHtml(r)}</td>`
      + `<td class="num">${money(r.tvl)}</td><td class="num">${r.change7d === null ? '—' : (r.change7d > 0 ? '+' : '') + r.change7d.toFixed(1) + '%'}</td>`
      + `<td class="num">${ageStr(r.ageDays)}</td><td class="num">${r.odds.toFixed(2)}</td>`
      + `<td class="num">${money(r.valueIfLaunches)}</td><td class="num"><b>${money(r.implied)}</b></td>`
      + `<td class="num">${money(r.p25)}–${money(r.p75)}</td><td class="v ${v.v}">${v.v}</td>`
      + `<td class="num">${usd(v.net)}</td><td class="num">${usd(v.netHour)}/h</td><td class="num">${r.rankLo}–${r.rankHi}</td></tr>`;
  }).join('');
  const farm = R.rows.filter((r) => verdictFor(r, state.dep, state.drop).v === 'FARM').length;
  $('kpiFarm').textContent = farm + ' of ' + R.rows.length;
  $('countLine').textContent = rows.length + ' of ' + R.rows.length + ' rows · deposit ' + state.dep + '× · drop share ' + Math.round(state.drop * 100) + '%';
  tb.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => showDetail(tr.getAttribute('data-slug'))));
}

function renderLedger() {
  const colors = ['#0f766e', '#2a9d8f', '#e9c46a', '#457b9d', '#6b7280', '#b45309', '#9c6644', '#7f4f24', '#bc6c25', '#606c38', '#8d99ae', '#adb5bd'];
  const total = R.ledger.reduce((s, g) => s + g.n, 0);
  $('ledgerBar').innerHTML = R.ledger.map((g, i) => `<div style="width:${(g.n / total * 100).toFixed(2)}%;background:${colors[i % colors.length]}" title="${esc(g.label)}: ${g.n}"></div>`).join('');
  $('ledgerChips').innerHTML = R.ledger.map((g, i) => `<span title="${esc(g.reason)}"><b style="background:${colors[i % colors.length]}"></b>${esc(g.label)} ${g.n}</span>`).join('');
  $('ledgerTable').innerHTML = R.ledger.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.n}</td><td>${esc(g.reason)}</td></tr>`).join('');
}

function stepHtml(s) {
  const ci = s.indexOf(' Cost: ');
  if (ci < 0) return esc(s);
  const ti = s.indexOf(' Time: ', ci);
  if (ti < 0) return esc(s);
  return esc(s.slice(0, ci)) + ' <span class="cost">Cost: ' + esc(s.slice(ci + 7, ti)) + '</span>'
    + ' <span class="cost">Time: ' + esc(s.slice(ti + 7)) + '</span>';
}

function showDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const v = verdictFor(r, state.dep, state.drop);
  const multiple = r.valueIfLaunches / Math.max(1, r.tvl);
  const peers = r.peers.map((p) => `<tr><td>${esc(p.name)}</td><td>${money(p.tvl)}</td><td>${money(p.mcap)}</td><td>${(p.ratio).toFixed(2)}×</td><td>${money(p.modelCap)}</td></tr>`).join('');
  const ageNote = r.ageDays === null ? ' No listed date is recorded, so the odds use the peer median age (' + Math.round(R.model.odds.medAgeDays) + ' days).' : '';
  const kinNote = r.kin ? ' <b>Kin:</b> its name matches a traded token’s stem or symbol, so it may be a sibling product of a token that already trades — read the odds with that in mind.' : '';
  $('detail').classList.remove('hidden');
  $('detail').innerHTML = `<h2>#${r.rank} ${esc(r.name)}</h2>`
    + `<p class="note">${esc(r.category || 'No category')} · ${r.chains.map(esc).join(', ')} · TVL ${money(r.tvl)} · 7d ${r.change7d === null ? '—' : r.change7d.toFixed(1) + '%'} · age ${ageStr(r.ageDays)} · ${r.badges.map(esc).join(', ')}.${ageNote}${kinNote}</p>`
    + `<div class="dgrid"><div><h3>How the figure is made</h3><table class="ev"><tbody>`
    + `<tr><td>TVL</td><td>${money(r.tvl)}</td></tr>`
    + `<tr><td>Size curve multiple</td><td>${multiple.toFixed(3)}× — log(mcap) = ${R.model.a.toFixed(3)} + ${R.model.b.toFixed(3)} · log(TVL), n=${R.model.nComps}</td></tr>`
    + `<tr><td>Value if it launches</td><td>${money(r.valueIfLaunches)}</td></tr>`
    + `<tr><td>Token odds</td><td>${r.odds.toFixed(2)} — logit on the 442 peers; base rate ${R.model.odds.baseRate.toFixed(3)}</td></tr>`
    + `<tr><td>Implied value</td><td><b>${money(r.implied)}</b> · P25–P75 ${money(r.p25)}–${money(r.p75)} · P10–P90 ${money(r.p10)}–${money(r.p90)}</td></tr>`
    + `<tr><td>Bootstrap rank</td><td>P10–P90 #${r.rankLo}–#${r.rankHi} over 200 refits</td></tr>`
    + `</tbody></table><h3>Nearest priced peers</h3><table class="ev"><thead><tr><th>Peer</th><th>TVL</th><th>Cap</th><th>Cap / TVL</th><th>Model cap</th></tr></thead><tbody>${peers}</tbody></table>`
    + `<p class="note">Same category first, by |log TVL| distance. Model cap is the held-out (leave-one-out) size-curve price — what the curve would have said without seeing that token.</p></div>`
    + `<div><h3>Farm economics — ${esc(v.v)}</h3><table class="ev"><tbody>`
    + `<tr><td>Deposit (${state.dep}× tier)</td><td>${usd(v.dep)}</td></tr>`
    + `<tr><td>Expected drop</td><td>${usd(v.drop)} — implied × ${Math.round(state.drop * 100)}% × deposit / TVL</td></tr>`
    + `<tr><td>Fees</td><td>${usd(v.fees)} — 6 tx on ${esc(r.chains[0] || 'its main chain')}</td></tr>`
    + `<tr><td>Time</td><td>${r.hours} h — costed ${usd(r.hours * R.benchmarks.hourRate)} at $25 / h</td></tr>`
    + `<tr><td>Net (cash after gas)</td><td><b>${usd(v.net)}</b></td></tr>`
    + `<tr><td>Net / hour</td><td>${usd(v.netHour)} / h — bar $25 / h</td></tr>`
    + `<tr><td>T-bill benchmark</td><td>${usd(v.tbill)} — 4% over ${R.benchmarks.horizonWeeks} weeks on the deposit</td></tr>`
    + `</tbody></table><h3>Farm plan — ${r.steps.length} steps</h3><ol class="steps">`
    + r.steps.map((s) => `<li>${stepHtml(s)}</li>`).join('')
    + `</ol></div></div>`;
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (history.replaceState) history.replaceState(null, '', '#detail=' + encodeURIComponent(slug));
}

function renderLive() {
  $('liveRows').innerHTML = R.liveTokens.map((t, i) => `<tr><td class="num">${i + 1}</td><td><b>${esc(t.name)}</b></td><td>${esc(t.category || '—')}</td><td class="num">${money(t.tvl)}</td><td class="num">${money(t.mcap)}</td><td class="num">${t.ratio.toFixed(2)}×</td><td class="num">${money(t.modelCap)}</td></tr>`).join('');
}

function renderPlot() {
  const W = 900, H = 340, PL = 64, PR = 18, PT = 14, PB = 34;
  const comps = R.liveTokens;
  const xs = comps.map((c) => Math.log(c.tvl)).concat(R.rows.map((r) => Math.log(r.tvl)));
  const ys = comps.map((c) => Math.log(c.mcap)).concat(R.rows.map((r) => Math.log(r.implied)));
  const x0 = Math.min(...xs) - 0.3, x1 = Math.max(...xs) + 0.3;
  const y0 = Math.min(...ys) - 0.3, y1 = Math.max(...ys) + 0.3;
  const X = (v) => PL + (v - x0) / (x1 - x0) * (W - PL - PR);
  const Y = (v) => PT + (1 - (v - y0) / (y1 - y0)) * (H - PT - PB);
  let g = '';
  for (let e = 6; e <= 9; e++) {
    const v = Math.log(Math.pow(10, e));
    if (v < x0 || v > x1) continue;
    g += `<line x1="${X(v).toFixed(1)}" y1="${PT}" x2="${X(v).toFixed(1)}" y2="${H - PB}" stroke="#e8e1cf"/><text x="${X(v).toFixed(1)}" y="${H - 14}" font-size="10" fill="#5b6470" text-anchor="middle">$${Math.pow(10, e - 6)}${e === 6 ? 'M' : e === 9 ? 'B' : '0M'}</text>`;
  }
  for (let e = 5; e <= 11; e++) {
    const v = Math.log(Math.pow(10, e));
    if (v < y0 || v > y1) continue;
    g += `<line x1="${PL}" y1="${Y(v).toFixed(1)}" x2="${W - PR}" y2="${Y(v).toFixed(1)}" stroke="#e8e1cf"/><text x="${PL - 6}" y="${(Y(v) + 3).toFixed(1)}" font-size="10" fill="#5b6470" text-anchor="end">$${Math.pow(10, e - 6)}${e < 9 ? 'M' : 'B'}</text>`;
  }
  const lx0 = X(x0), ly0 = Y(R.model.a + R.model.b * x0), lx1 = X(x1), ly1 = Y(R.model.a + R.model.b * x1);
  g += `<line x1="${lx0.toFixed(1)}" y1="${ly0.toFixed(1)}" x2="${lx1.toFixed(1)}" y2="${ly1.toFixed(1)}" stroke="#0f766e" stroke-width="2"/>`;
  for (const c of comps) g += `<circle cx="${X(Math.log(c.tvl)).toFixed(1)}" cy="${Y(Math.log(c.mcap)).toFixed(1)}" r="2.6" fill="#0f766e" opacity="0.55"/>`;
  for (const r of R.rows) {
    const x = X(Math.log(r.tvl)), y = Y(Math.log(r.implied));
    g += `<line x1="${(x - 3).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 3).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#b45309" stroke-width="1.4"/><line x1="${x.toFixed(1)}" y1="${(y - 3).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y + 3).toFixed(1)}" stroke="#b45309" stroke-width="1.4"/>`;
  }
  g += `<text x="${PL}" y="${PT - 2}" font-size="11" fill="#1d2733">log TVL → · log market cap / implied value ↑</text>`;
  $('plot').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of traded tokens against the fitted size curve">${g}</svg>`;
}

function setTab(tab) {
  state.tab = tab;
  $('tabBoard').classList.toggle('on', tab === 'board');
  $('tabLive').classList.toggle('on', tab === 'live');
  $('board').classList.toggle('hidden', tab !== 'board');
  $('live').classList.toggle('hidden', tab !== 'live');
  $('boardNote').classList.toggle('hidden', tab !== 'board');
}

function init() {
  renderLedger();
  renderBoard();
  renderLive();
  renderPlot();
  $('q').addEventListener('input', (e) => { state.q = e.target.value; renderBoard(); });
  $('badge').addEventListener('change', (e) => { state.badge = e.target.value; renderBoard(); });
  $('verdict').addEventListener('change', (e) => { state.verdict = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderBoard(); });
  $('depScale').addEventListener('change', (e) => { state.dep = parseFloat(e.target.value); renderBoard(); });
  $('dropShare').addEventListener('input', (e) => {
    state.drop = parseInt(e.target.value, 10) / 100;
    $('dropVal').textContent = e.target.value + '%';
    renderBoard();
  });
  $('tabBoard').addEventListener('click', () => setTab('board'));
  $('tabLive').addEventListener('click', () => setTab('live'));
  document.querySelectorAll('#board thead th[data-k]').forEach((th) => th.addEventListener('click', () => {
    const k = th.getAttribute('data-k');
    state.sort = k === 'rank' || k === 'implied' ? 'implied' : k === 'name' ? 'implied' : k === 'chg' ? 'implied' : k;
    renderBoard();
  }));
  const h = location.hash || '';
  const dm = h.match(/#detail=([^&]+)/);
  const fm = h.match(/#filter=([^&]+)/);
  if (dm) showDetail(decodeURIComponent(dm[1]));
  else if (fm) {
    const f = decodeURIComponent(fm[1]);
    if (['Watchlist', 'Early', 'Off-list', 'Kin'].includes(f)) { state.badge = f; $('badge').value = f; renderBoard(); }
  }
}

document.addEventListener('DOMContentLoaded', init);

