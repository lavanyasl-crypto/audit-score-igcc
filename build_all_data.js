// Consolidated Node port of analysis.py + build_dashboard_data.py + build_param_data.py +
// build_unaudited_data.js.py — rebuilds all dashboard data files from the updated CSVs.
// Sources (updated 2026-10-07):
//   Audit response wide/Pod Audit Tool - Audit Responses (Wide) (2).csv   (audits 2026-08-31 → 10-07)
//   Store IGCC/IGCC _Daily Summary - Store inc.csv                        (daily FnV orders+IGCC, 2026-05-01 → 10-06)
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;

const WIDE = path.join(ROOT, 'Audit response wide', 'Pod Audit Tool - Audit Responses (Wide) (2).csv');
const IGCC = path.join(ROOT, 'Store IGCC', 'IGCC _Daily Summary - Store inc.csv');
const PER_AUDIT = path.join(ROOT, 'per_audit_igcc.csv');
const WINDOW_DAYS = 7; // fallback window for single-audit / unaudited pods
const SEED = 42;

// ---------- CSV parsing (handles quoted fields) ----------
function parseCSVLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------- load audits (wide) ----------
const audRaw = [];
{
  const lines = fs.readFileSync(WIDE, 'utf8').trim().split(/\r?\n/);
  const hdr = parseCSVLine(lines[0]);
  const idx = {};
  ['City', 'Auditor Name', 'Date', 'Store Name', 'Store ID', 'Score %'].forEach(k => idx[k] = hdr.indexOf(k));
  for (const c of hdr) idx[c] = hdr.indexOf(c);
  for (let i = 1; i < lines.length; i++) {
    const p = parseCSVLine(lines[i]);
    const id = parseInt(p[idx['Store ID']], 10);
    const date = (p[idx['Date']] || '').trim();
    const score = parseFloat(p[idx['Score %']]);
    if (!Number.isFinite(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(score)) continue;
    const row = { id, date, score, city: p[idx['City']], auditor: p[idx['Auditor Name']], name: p[idx['Store Name']] };
    row.scores = hdr.map((h, j) => (h.endsWith(' (Score)') ? j : -1)).filter(j => j >= 0).map(j => {
      const v = parseInt(p[j], 10);
      return Number.isFinite(v) ? v : null;
    });
    row.scoreCols = hdr.map((h, j) => (h.endsWith(' (Score)') ? h : null)).filter(Boolean);
    audRaw.push(row);
  }
}
// attach scoreCol names once
if (audRaw.length) {
  const lines0 = fs.readFileSync(WIDE, 'utf8').trim().split(/\r?\n/);
  const hdr = parseCSVLine(lines0[0]);
  audRaw.scoreCols = hdr.filter(h => h.endsWith(' (Score)'));
}

// parameter score columns (exclude section-rollup pseudo-params) — port of build_param_data.py filter
const scoreCols = (audRaw.scoreCols || []).filter(h =>
  !h.startsWith('FNV - Chiller Zone') &&
  !h.includes('Inward temperature record') &&
  !h.startsWith('FNV - Is the inward') &&
  h !== 'Result (Score)' &&
  !h.endsWith('Questions Completed (Score)'));
const paramNames = scoreCols.map(c => c.slice(0, -len(' (Score)')));
function len(s) { return s.length; }

// ---------- load IGCC daily ----------
const dailyByStore = new Map(); // id -> Map(date -> {tot, igcc})
const storeMeta = new Map();    // id -> {city2, tier}
{
  const lines = fs.readFileSync(IGCC, 'utf8').trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const p = parseCSVLine(line);
    if (p.length < 9) continue;
    const id = parseInt(p[4], 10), date = p[5];
    const tot = parseFloat(p[7]), igcc = parseFloat(p[8]);
    if (!Number.isFinite(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!dailyByStore.has(id)) dailyByStore.set(id, new Map());
    const d = dailyByStore.get(id);
    const cur = d.get(date) || { tot: 0, igcc: 0 };
    cur.tot += Number.isFinite(tot) ? tot : 0;
    cur.igcc += Number.isFinite(igcc) ? igcc : 0;
    d.set(date, cur);
    if (!storeMeta.has(id)) storeMeta.set(id, { city2: p[2], tier: p[3] });
  }
}

// helper: aggregate window [from, to) over a store's daily map
function windowAgg(d, from, toExcl) {
  let tot = 0, igcc = 0, days = 0;
  d.forEach((v, date) => {
    if (date >= from && date < toExcl) { tot += v.tot; igcc += v.igcc; days++; }
  });
  return { qnp: tot > 0 ? igcc / tot : null, tot, days };
}
function addDays(dstr, n) {
  const d = new Date(dstr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- audits per store (dedup same-day) ----------
const byStore = new Map();
audRaw.forEach(a => {
  if (!byStore.has(a.id)) byStore.set(a.id, []);
  byStore.get(a.id).push(a);
});
byStore.forEach(arr => arr.sort((x, y) => x.date < y.date ? -1 : 1));

// "today" for stretching the last audit's window — day after max IGCC data date (data runs to 2026-10-05)
const TODAY = '2026-10-07';

// ---------- per-audit IGCC windows ----------
const perAudit = [];
byStore.forEach((grp, id) => {
  const d = dailyByStore.get(id);
  if (!d) return;
  // dedup same-day audit rows (count distinct dates)
  const seen = new Set(); const audits = [];
  for (const a of grp) { if (!seen.has(a.date)) { seen.add(a.date); audits.push(a); } }
  audits.forEach((a, i) => {
    const next = audits[i + 1] || null;
    const prev = audits[i - 1] || null;
    // Shared-window rule (user, approved 2026-10-02), e.g. audits Sep 1 & Sep 13 (gap 12), viewed Oct 2:
    //  - pre of 1st audit   = the `gap` days before audit 1          [a-gap, a)    (12 days)
    //  - SHARED window      = days strictly BETWEEN the two audits   (a, next)     (gap-1 days)
    //      used for BOTH post of audit i AND pre of audit i+1 → identical % by construction
    //  - post of LAST audit = audit date → date of viewing (TODAY)
    //  - single audit / no audit: 7-day windows
    let pre, preFrom;
    if (prev) {
      // pre of audit 2+ = the shared between-window (same days as previous audit's post)
      preFrom = addDays(prev.date, 1);
      pre = windowAgg(d, preFrom, a.date);
    } else if (next) {
      preFrom = addDays(a.date, -(new Date(next.date) - new Date(a.date)) / 86400000);
      pre = windowAgg(d, preFrom, a.date);
    } else {
      preFrom = addDays(a.date, -WINDOW_DAYS);
      pre = windowAgg(d, preFrom, a.date);
    }
    const preGap = Math.max(Math.round((new Date(a.date) - new Date(preFrom)) / 86400000), 1);
    let post, postDays;
    if (next) {
      // shared between-window: (a, next) exclusive both ends — identical to next audit's pre
      post = windowAgg(d, addDays(a.date, 1), next.date);
      postDays = Math.max(Math.round((new Date(next.date) - new Date(a.date)) / 86400000) - 1, 0);
      if (postDays === 0) post = { qnp: null, tot: 0, days: 0 };
    } else {
      post = windowAgg(d, a.date, addDays(TODAY, 1)); // audit date → date of viewing
    }
    // guard: post must not include the next audit date — handled naturally since
    // next audit's date > a.date and window ends a+gap < next.date when gap = distance
    const preQ = pre.qnp != null ? +pre.qnp.toFixed(5) : null;
    const postQ = post.qnp != null ? +post.qnp.toFixed(5) : null;
    const lastAudit = !next;
    perAudit.push({
      store_id: id, audit_no: i + 1, audit_date: a.date,
      city: a.city, auditor: a.auditor || '', score_pct: a.score,
      window_days: preGap,   // pre window length
      post_window_days: lastAudit ? (new Date(TODAY) - new Date(a.date)) / 86400000 + 1 : postDays,
      pre_qnp: preQ, post_qnp: postQ,
      pre_orders: Math.round(pre.tot), post_orders: Math.round(post.tot),
      pre_days: pre.days, post_days: lastAudit ? post.days : postDays,
      // per-parameter scores for this audit (param order = paramNames)
      scores: (function () {
        // map scoreCols (full list incl excluded) → this audit's raw values by name
        return scoreCols.map(sc => {
          const j = audRaw.scoreCols.indexOf(sc);
          // raw values were captured positionally over all (Score) cols; recompute by name:
          return a._byname ? a._byname[sc] : (a.scores[j] != null ? a.scores[j] : null);
        });
      })(),
    });
  });
});

// fix scores-by-name: rebuild from file to be safe
{
  const lines = fs.readFileSync(WIDE, 'utf8').trim().split(/\r?\n/);
  const hdr = parseCSVLine(lines[0]);
  const si = hdr.indexOf('Store ID'), di = hdr.indexOf('Date');
  const scoreIdx = new Map(); // "id|date" -> {col: val}
  for (let i = 1; i < lines.length; i++) {
    const p = parseCSVLine(lines[i]);
    const id = parseInt(p[si], 10), date = (p[di] || '').trim();
    if (!Number.isFinite(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const m = scoreIdx.get(id + '|' + date) || {};
    hdr.forEach((h, j) => { if (h.endsWith(' (Score)')) { const v = parseInt(p[j], 10); m[h] = Number.isFinite(v) ? v : null; } });
    scoreIdx.set(id + '|' + date, m);
  }
  perAudit.forEach(pa => {
    const m = scoreIdx.get(pa.store_id + '|' + pa.audit_date);
    pa.scores = scoreCols.map(sc => (m && m[sc] != null) ? m[sc] : null);
  });
}

// ---------- store summary (first vs last audit) ----------
const storesOut = [];
byStore.forEach((grp, id) => {
  const seen = new Set(); const audits = [];
  for (const a of grp) { if (!seen.has(a.date)) { seen.add(a.date); audits.push(a); } }
  if (!audits.length) return;
  const first = audits[0], second = audits[1] || null;
  const pa1 = perAudit.find(p => p.store_id === id && p.audit_no === 1);
  const pa2 = perAudit.find(p => p.store_id === id && p.audit_no === 2);
  const meta = storeMeta.get(id) || { city2: '', tier: '' };
  storesOut.push({
    store_id: id, store_name: first.name || '', city: first.city || '',
    city_2: meta.city2 || '', tier: meta.tier || '',
    n_audits: audits.length,
    audit1_date: first.date, audit1_score: first.score,
    audit2_score: second ? second.score : null,
    audit1_pre_qnp: pa1 ? pa1.pre_qnp : null, audit1_post_qnp: pa1 ? pa1.post_qnp : null,
    audit2_pre_qnp: pa2 ? pa2.pre_qnp : null, audit2_post_qnp: pa2 ? pa2.post_qnp : null,
    win1_days: pa1 ? pa1.window_days : null, win2_days: pa2 ? pa2.window_days : null,
  });
});

// ---------- write dashboard_data.js ----------
{
  const storePayload = storesOut.map(r => [
    r.store_id, r.store_name, r.city, r.city_2, r.tier, r.n_audits,
    r.audit1_date, r.audit1_score, null,
    r.audit2_score, null,
    r.audit1_pre_qnp, r.audit1_post_qnp, r.audit2_pre_qnp, r.audit2_post_qnp,
    r.win1_days, r.win2_days,
  ]);
  const auditPayload = perAudit.map(r => [
    r.store_id, r.audit_no, r.audit_date, r.city, r.auditor, r.score_pct, null,
    r.pre_qnp, r.post_qnp, r.pre_orders, r.post_orders, r.window_days,
  ]);
  // DAILY for never-audited pods — from the raw IGCC file (all stores)
  const auditedIds = new Set(storesOut.map(s => s.store_id));
  const dailyRecords = [];
  dailyByStore.forEach((d, id) => {
    if (auditedIds.has(id)) return;
    [...d.entries()].sort((x, y) => x[0] < y[0] ? -1 : 1).forEach(([date, v]) => {
      dailyRecords.push([id, date, Math.round(v.tot), Math.round(v.igcc)]);
    });
  });
  // AUDITED_DAILY — daily FnV orders + IGCC for AUDITED pods (drives the Trends tab line graphs)
  const auditedDaily = [];
  dailyByStore.forEach((d, id) => {
    if (!auditedIds.has(id)) return;
    [...d.entries()].sort((x, y) => x[0] < y[0] ? -1 : 1).forEach(([date, v]) => {
      auditedDaily.push([id, date, Math.round(v.tot), Math.round(v.igcc)]);
    });
  });
  const js = 'const STORES = ' + JSON.stringify(storePayload) +
    ';\nconst AUDITS = ' + JSON.stringify(auditPayload) +
    ';\nconst DAILY = ' + JSON.stringify(dailyRecords) +
    ';\nconst AUDITED_DAILY = ' + JSON.stringify(auditedDaily) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'dashboard_data.js'), js);
  console.log('dashboard_data.js:', storePayload.length, 'stores,', auditPayload.length, 'audits,', dailyRecords.length, 'unaudited daily rows,', auditedDaily.length, 'audited daily rows');
}

// ---------- write param_data.js ----------
{
  const results = perAudit.map(r => ({
    store_id: r.store_id, audit_no: r.audit_no, audit_date: r.audit_date,
    city: r.city, city2: (storeMeta.get(r.store_id) || {}).city2 || '',
    tier: (storeMeta.get(r.store_id) || {}).tier || '',
    auditor: r.auditor, score_pct: r.score_pct,
    pre_qnp: r.pre_qnp, post_qnp: r.post_qnp, scores: r.scores,
  }));
  const js = 'const PARAM_NAMES = ' + JSON.stringify(paramNames) +
    ';\nconst PARAM_AUDITS = ' + JSON.stringify(results) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'param_data.js'), js);
  console.log('param_data.js:', results.length, 'audit rows,', paramNames.length, 'params');
}

// ---------- write unaudited_data.js (AUDIT_GROUPS) ----------
{
  // deterministic pseudo dates for never-audited pods (mulberry32 seeded, port of numpy default_rng(42) intent)
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(SEED);
  const auditedIds = new Set(storesOut.map(s => s.store_id));
  const allDates = audRaw.map(a => a.date).sort();
  const dLo = allDates[0], dHi = allDates[allDates.length - 1];
  const span = Math.round((new Date(dHi) - new Date(dLo)) / 86400000);
  // store names from wide file
  const names = new Map();
  audRaw.forEach(a => { if (a.name && !names.has(a.id)) names.set(a.id, a.name); });

  const rows = [];
  // audited pods: pre of 1st audit, post of last audit
  byStore.forEach((grp, id) => {
    const pas = perAudit.filter(p => p.store_id === id).sort((a, b) => a.audit_no - b.audit_no);
    if (!pas.length) return;
    const first = pas[0], last = pas[pas.length - 1];
    const meta = storeMeta.get(id) || { city2: '', tier: '' };
    rows.push({
      id, n: pas.length, date: first.audit_date,
      pre: first.pre_qnp, post: last.post_qnp,
      win_days: first.window_days,
      city2: meta.city2 || '', tier: meta.tier || '',
      name: names.get(id) || '', pseudo: false,
    });
  });
  // never-audited: pseudo audit date + 7-day windows
  const neverIds = [...dailyByStore.keys()].filter(id => !auditedIds.has(id)).sort((a, b) => a - b);
  neverIds.forEach(id => {
    const d = dailyByStore.get(id);
    const meta = storeMeta.get(id) || { city2: '', tier: '' };
    const pseudo = addDays(dLo, Math.floor(rng() * (span + 1)));
    const pre = windowAgg(d, addDays(pseudo, -WINDOW_DAYS), pseudo);
    const post = windowAgg(d, pseudo, addDays(pseudo, WINDOW_DAYS + 1));
    rows.push({
      id, n: 0, date: pseudo,
      pre: pre.qnp != null ? +pre.qnp.toFixed(5) : null,
      post: post.qnp != null ? +post.qnp.toFixed(5) : null,
      win_days: WINDOW_DAYS,
      city2: meta.city2 || '', tier: meta.tier || '',
      name: names.get(id) || '', pseudo: true,
    });
  });
  const js = 'const AUDIT_GROUPS = ' + JSON.stringify(rows) + ';\n';
  fs.writeFileSync(path.join(ROOT, 'unaudited_data.js'), js);
  console.log('unaudited_data.js:', rows.length, 'groups (', neverIds.length, 'unaudited )');
}

// ---------- write per_audit_igcc.csv (for build_orders_data.js) ----------
{
  const head = 'store_id,audit_no,audit_date,city,auditor,score_pct,fnv_compliance,window_days,pre_qnp,post_qnp,pre_orders,post_orders,pre_days,post_days';
  const rows = perAudit.map(r => [
    r.store_id, r.audit_no, r.audit_date, r.city, r.auditor, r.score_pct, '',
    r.window_days, r.pre_qnp ?? '', r.post_qnp ?? '', r.pre_orders, r.post_orders, r.pre_days, r.post_days,
  ].join(','));
  fs.writeFileSync(path.join(ROOT, 'per_audit_igcc.csv'), head + '\n' + rows.join('\n') + '\n');
  console.log('per_audit_igcc.csv:', rows.length, 'rows');
}

// ---------- store summary CSV (store_summary.csv) ----------
{
  const head = 'store_id,store_name,city,city_2,tier,n_audits,audit1_date,audit1_score,audit1_fnv,audit2_score,audit2_fnv,audit_last_date,audit_last_score,audit1_pre_qnp,audit1_post_qnp,audit2_pre_qnp,audit2_post_qnp';
  const rows = storesOut.map(r => [
    r.store_id, JSON.stringify(r.store_name), r.city, r.city_2, r.tier, r.n_audits,
    r.audit1_date, r.audit1_score ?? '', '', r.audit2_score ?? '', '',
    r.audit1_date, r.audit1_score ?? '',
    r.audit1_pre_qnp ?? '', r.audit1_post_qnp ?? '', r.audit2_pre_qnp ?? '', r.audit2_post_qnp ?? '',
  ].join(','));
  fs.writeFileSync(path.join(ROOT, 'store_summary.csv'), head + '\n' + rows.join('\n') + '\n');
  console.log('store_summary.csv:', rows.length, 'rows');
}

// ---------- summary stats ----------
{
  const s1 = storesOut.filter(s => s.audit1_score != null);
  const s2 = storesOut.filter(s => s.audit2_score != null);
  const out = {
    n_stores: s1.length,
    avg_score_audit1: s1.length ? +(s1.reduce((x, s) => x + s.audit1_score, 0) / s1.length).toFixed(1) : null,
    n_stores_2audits: s2.length,
    avg_score_audit2: s2.length ? +(s2.reduce((x, s) => x + s.audit2_score, 0) / s2.length).toFixed(1) : null,
  };
  fs.writeFileSync(path.join(ROOT, 'summary_stats.json'), JSON.stringify(out, null, 2));
  console.log('summary_stats.json:', JSON.stringify(out));
}
console.log('DONE');
