// Builds orders_data.js for the "Total Orders vs Audits" tab.
// Sources (updated 2026-10-06):
//   Store IGCC/IGCC _Daily Summary - Orders.csv             — store-level ALL-category orders (2026-09-19 → 09-28)
//   Store IGCC/IGCC _Daily Summary - Store inc.csv          — store-level FnV orders + IGCC (2026-05-01 → 10-05)
//   dashboard_data.js  (STORES / AUDITS / DAILY)            — audits + pre/post IGCC windows
//   per_audit_igcc.csv                                      — audit-level pre/post QNP + FnV orders
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const dd = require(path.join(ROOT, '.tmp', 'dd.js'));   // STORES, AUDITS, DAILY
const ag = require(path.join(ROOT, '.tmp', 'ag.js'));   // AUDIT_GROUPS
const { STORES, AUDITS } = dd;
const AUDIT_GROUPS = ag.AUDIT_GROUPS;

// ---------- load Orders.csv (all-category, store-level, DD-MM-YYYY) ----------
function dmyToIso(s) {
  const [d, m, y] = s.split('-');
  return `${y}-${m}-${d}`;
}
const totalOrders = new Map(); // store_id -> { isoDate: orders }
{
  const lines = fs.readFileSync(path.join(ROOT, 'Store IGCC', 'IGCC _Daily Summary - Orders.csv'), 'utf8')
    .trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 4) continue;
    const id = +p[2], date = dmyToIso(p[1]), ord = +p[3];
    if (!Number.isFinite(id) || !Number.isFinite(ord)) continue;
    if (!totalOrders.has(id)) totalOrders.set(id, {});
    totalOrders.get(id)[date] = ord;
  }
}

// ---------- load Store inc.csv (FnV, store-level daily) ----------
const fnvDaily = new Map(); // store_id -> { isoDate: {tot, igcc, city, city2, tier} }
{
  const lines = fs.readFileSync(path.join(ROOT, 'Store IGCC', 'IGCC _Daily Summary - Store inc.csv'), 'utf8')
    .trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 9) continue;
    const id = +p[4], date = p[5], tot = +p[7], igcc = +p[8];
    if (!Number.isFinite(id)) continue;
    if (!fnvDaily.has(id)) fnvDaily.set(id, {});
    fnvDaily.get(id)[date] = { tot, igcc, city: p[1], city2: p[2], tier: p[3] };
  }
}

// ---------- per-audit pre/post TOTAL orders from Orders.csv ----------
// Window rule (same as build_all_data.js): pre = the `gap` days before the audit,
// post = the `gap` days after (up to the next audit); for a pod's LAST audit the
// post window runs from the audit date to the date of viewing (TODAY); single
// audits use 7 days. Orders.csv only covers 2026-09-19..09-28, so a window may be
// partial → also report covered days.
const TODAY = '2026-10-06';
function windowTotalOrders(id, auditDate, gapDays, isLast) {
  const m = totalOrders.get(id);
  if (!m) return null;
  const gap = gapDays || 7;
  // UTC dates throughout — local (IST) midnight shifts toISOString back a day
  const d = new Date(auditDate + 'T00:00:00Z');
  let preTot = 0, preDays = 0, postTot = 0, postDays = 0;
  for (let i = 1; i <= gap; i++) {
    const a = new Date(d); a.setUTCDate(d.getUTCDate() - i);
    const ka = a.toISOString().slice(0, 10);
    if (m[ka] != null) { preTot += m[ka]; preDays++; }
  }
  if (isLast) {
    for (let k = auditDate; k <= TODAY; ) {
      if (m[k] != null) { postTot += m[k]; postDays++; }
      const t = new Date(k + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1);
      k = t.toISOString().slice(0, 10);
    }
  } else {
    for (let i = 1; i <= gap; i++) {
      const b = new Date(d); b.setUTCDate(d.getUTCDate() + i);
      const kb = b.toISOString().slice(0, 10);
      if (m[kb] != null) { postTot += m[kb]; postDays++; }
    }
  }
  return { preTot: preTot || null, preDays, postTot: postTot || null, postDays };
}

// ---------- build per-audit rows ----------
// [store_id, audit_no, audit_date, score, pre_qnp, post_qnp, pre_fnv_ord, post_fnv_ord,
//  pre_tot_ord, post_tot_ord, pre_days_cov, post_days_cov, win_days]
const auditsOut = [];
{
  const per = fs.readFileSync(path.join(ROOT, 'per_audit_igcc.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
  // first pass: pod's max audit_no (its last audit → post window runs to TODAY)
  const maxNo = new Map();
  for (const r of parsePerAudit(per)) {
    maxNo.set(r.id, Math.max(maxNo.get(r.id) || 0, r.no));
  }
  for (const r of parsePerAudit(per)) {
    const t = windowTotalOrders(r.id, r.date, r.winD || 7, r.no === maxNo.get(r.id));
    // [.,.,.,.,preQ,postQ,preF,postF, preTot,postTot, per_audit_pre_days, per_audit_post_days, totPreCov, totPostCov, win_days]
    auditsOut.push([r.id, r.no, r.date, r.score, r.preQ, r.postQ, r.preO, r.postO,
      t ? t.preTot : null, t ? t.postTot : null, r.preD, r.postD,
      t ? t.preDays : 0, t ? t.postDays : 0, r.winD]);
  }
}
// parse helper for the per_audit_igcc.csv rows
function parsePerAudit(per) {
  const out = [];
  for (const line of per) {
    const p = line.split(',');
    if (p.length < 14) continue;
    out.push({
      id: +p[0], no: +p[1], date: p[2], score: p[5] === '' ? null : +p[5],
      winD: p[7] === '' ? null : +p[7],
      preQ: p[8] === '' ? null : +p[8], postQ: p[9] === '' ? null : +p[9],
      preO: p[10] === '' ? null : +p[10], postO: p[11] === '' ? null : +p[11],
      preD: p[12] === '' ? 0 : +p[12], postD: p[13] === '' ? 0 : +p[13],
    });
  }
  return out;
}

// ---------- per-pod rows ----------
// [id, name, city, city2, tier, n_audits, audits_dates_csv, avg_score,
//  a1_preF, a1_preIg, a1_preQ, a1_postF, a1_postIg, a1_postQ, a1_winD,
//  a2_preF, a2_preIg, a2_preQ, a2_postF, a2_postIg, a2_postQ, a2_winD]
// (FnV orders / IGCC orders per audit's pre & post windows; a2_* null for 1-audit pods)
const nameById = new Map(STORES.map(s => [s[0], s[1]]));
const cityById = new Map(STORES.map(s => [s[0], s[2]]));
const ORD_FROM = '2026-09-19', ORD_TO = '2026-09-28';

const podsOut = [];
const podIds = new Map(); // id -> index into podsOut
AUDIT_GROUPS.forEach(g => {
  const id = g.id;
  const auditsFor = AUDITS.filter(a => a[0] === id);
  const perRows = auditsOut.filter(r => r[0] === id);
  // audit 1 primary — defines the pre/post window
  const a1 = perRows.find(r => r[1] === 1) || perRows[0];
  // total + fnv orders over the EXACT same days that produced the IGCC pre/post %:
  // pre = pre_days consecutive days ending at audit1-1; post = post_days days starting at audit1+1
  // (analysis.py windows; per_audit pre_days/post_days record the actual days with data)
  const tm = totalOrders.get(id) || {};
  const fm = fnvDaily.get(id) || {};
  // per-audit FnV/IGCC orders over that audit's exact windows (shared-window rule):
  //  - pre of 1st audit: pre_days before it; shared between-window for post of audit N
  //    and pre of audit N+1; last audit's post: audit date → TODAY
  function auditOrders(auditDate, preDays, postDays, isLast) {
    const d0 = new Date(auditDate + 'T00:00:00Z');
    let preFv = 0, preIg = 0, postFv = 0, postIg = 0;
    for (let i = 1; i <= preDays; i++) {
      const a = new Date(d0); a.setUTCDate(d0.getUTCDate() - i);
      const k = a.toISOString().slice(0, 10);
      if (fm[k]) { preFv += fm[k].tot; preIg += fm[k].igcc; }
    }
    if (isLast) {
      for (let k = auditDate; ; ) {
        if (fm[k]) { postFv += fm[k].tot; postIg += fm[k].igcc; }
        if (k >= TODAY) break;
        const t = new Date(k + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + 1);
        k = t.toISOString().slice(0, 10);
      }
    } else {
      for (let i = 1; i <= postDays; i++) {
        const b = new Date(d0); b.setUTCDate(d0.getUTCDate() + i);
        const k = b.toISOString().slice(0, 10);
        if (fm[k]) { postFv += fm[k].tot; postIg += fm[k].igcc; }
      }
    }
    return {
      preF: preFv || null, preIg: preIg || null,
      postF: postFv || null, postIg: postIg || null,
      preQ: preFv > 0 ? +(preIg / preFv).toFixed(5) : null,
      postQ: postFv > 0 ? +(postIg / postFv).toFixed(5) : null,
    };
  }
  const a1row = perRows.find(r => r[1] === 1);
  const a2row = perRows.find(r => r[1] === 2);
  const o1 = a1row ? auditOrders(a1row[2], a1row[10] || 0, a1row[11] || 0, false) : null;
  const o2 = a2row ? auditOrders(a2row[2], a2row[10] || 0, a2row[11] || 0, true) : null;
  const scores = auditsFor.map(a => a[5]).filter(v => v != null);
  const avgScore = scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null;
  const incRow = Object.values(fm)[0];
  podsOut.push([
    id,
    nameById.get(id) || g.name || null,
    cityById.get(id) || (incRow ? incRow.city : null),
    g.city2 || (incRow ? incRow.city2 : null),
    g.tier || (incRow ? incRow.tier : null),
    g.n,
    auditsFor.map(a => a[2]).join(' | '),
    avgScore == null ? null : +avgScore.toFixed(1),
    o1 ? o1.preF : null,  o1 ? o1.preIg : null,  o1 ? o1.preQ : null,
    o1 ? o1.postF : null, o1 ? o1.postIg : null, o1 ? o1.postQ : null,
    a1row ? a1row[10] : null, // pre window days audit 1
    o2 ? o2.preF : null,  o2 ? o2.preIg : null,  o2 ? o2.preQ : null,
    o2 ? o2.postF : null, o2 ? o2.postIg : null, o2 ? o2.postQ : null,
    a2row ? a2row[10] : null, // pre window days audit 2
  ]);
  podIds.set(id, podsOut.length - 1);
});

// ---------- city-level totals (aggregated from audit-1 windows of filtered pods) ----------
// [city2, fnv_ord_win, igcc_ord_win, qnp, audits, pods]
const cityOut = [];
{
  const cityAgg = new Map(); // city2 -> {fnvT, igc, audits, pods}
  podsOut.forEach(r => {
    const c2 = r[3] || 'others';
    if (!cityAgg.has(c2)) cityAgg.set(c2, { fnvT: 0, igc: 0, audits: 0, pods: 0 });
    const o = cityAgg.get(c2);
    if (r[8]) o.fnvT += r[8];
    if (r[9]) o.igc += r[9];
    o.audits += r[5];
    o.pods++;
  });
  [...cityAgg.entries()].sort((a, b) => b[1].fnvT - a[1].fnvT).forEach(([c2, o]) => {
    cityOut.push([c2, o.fnvT || null, o.igc || null, o.fnvT > 0 ? +(o.igc / o.fnvT).toFixed(5) : null, o.audits, o.pods]);
  });
}

// ---------- week-level city summary (from daily city file, aggregated per week) ----------
// [city2, week, orders_total, orders_igcc, qnp]
const weekOut = [];
{
  const lines = fs.readFileSync(path.join(ROOT, 'Store IGCC', 'IGCC _Daily Summary - Cat .inc.csv'), 'utf8')
    .trim().split(/\r?\n/).slice(1);
  const agg = new Map(); // city2|week -> {tot, igcc}
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 9) continue;
    const cat = p[0], city2 = p[2], week = +p[5], tot = +p[6], igcc = +p[7];
    if (cat !== 'FnV' || !Number.isFinite(week) || !Number.isFinite(tot)) continue;
    const k = city2 + '|' + week;
    if (!agg.has(k)) agg.set(k, { tot: 0, igcc: 0 });
    const a = agg.get(k);
    a.tot += tot; a.igcc += igcc;
  }
  [...agg.entries()].sort((x, y) => x[0].localeCompare(y[0])).forEach(([k, a]) => {
    const [city2, wk] = k.split('|');
    weekOut.push([city2, +wk, a.tot, a.igcc, a.tot > 0 ? +(a.igcc / a.tot).toFixed(5) : null]);
  });
}

const meta = {
  ord_from: ORD_FROM, ord_to: ORD_TO,
  total_ord_coverage: `${ORD_FROM} → ${ORD_TO} (all-category orders file coverage; window totals limited to this span)`,
  fnv_coverage: '2026-05-01 → 2026-10-05',
  window_note: 'Total/FnV/IGCC orders use the same audit-gap windows as IGCC pre/post %',
  generated: new Date().toISOString().slice(0, 10)
};

const out = `// Generated by build_orders_data.js on ${meta.generated}
const ORDERS_META = ${JSON.stringify(meta)};
const POD_ORDERS = ${JSON.stringify(podsOut)};
const AUDIT_ORDERS = ${JSON.stringify(auditsOut)};
const CITY_ORDERS = ${JSON.stringify(cityOut)};
const CITY_WEEKS = ${JSON.stringify(weekOut)};
`;
fs.writeFileSync(path.join(ROOT, 'orders_data.js'), out);
console.log('orders_data.js written:',
  podsOut.length, 'pods,', auditsOut.length, 'audits,', cityOut.length, 'city rows,', weekOut.length, 'week rows');
console.log('pods with total orders:', podsOut.filter(r => r[8]).length, '/', podsOut.length);
