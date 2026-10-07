// Build rca_windows_data.js — IGCC claims split by root-cause bucket within each audited
// pod's pre/post audit windows, using the SAME shared-window rule as build_all_data.js.
// Reads per_audit_igcc.csv (window definitions) + the bucketing CSV; joins store meta from
// dashboard_data.js. Output rows: [storeId, auditNo, bucket, preClaims, postClaims, preFnvOrders, postFnvOrders]
// where pre/post FnV orders come from the pod's daily IGCC file so bucket % is claims/orders.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = __dirname;

const PER_AUDIT = path.join(ROOT, 'per_audit_igcc.csv');
const BUCKET_CSV = path.join(ROOT, 'IGCC bucketing', 'Bucketing', 'IGCC Daily RCA - Bucketing v2.csv');
const REASONS_CSV = path.join(ROOT, 'IGCC bucketing', 'Igcc reasons', 'IGCC Daily RCA - IGCC_REAONS.csv');

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

// ---------- reason → bucket map (trust the sheet, same as build_rca_data.js) ----------
const reasonBucket = {};
{
  const lines = fs.readFileSync(REASONS_CSV, 'utf8').trim().split(/\r?\n/);
  const hdr = parseCSVLine(lines[0]);
  const iR = hdr.indexOf('IGCC_REASON'), iB = hdr.indexOf('Bucket');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p = parseCSVLine(lines[i]);
    reasonBucket[p[iR].trim()] = p[iB].trim();
  }
}

// ---------- window definitions from per_audit_igcc.csv ----------
// windows[storeId][auditNo] = {preFrom, preTo(excl), postFrom, postTo(excl)}
const windows = new Map();
{
  const lines = fs.readFileSync(PER_AUDIT, 'utf8').trim().split(/\r?\n/);
  const hdr = parseCSVLine(lines[0]);
  const iStore = hdr.indexOf('store_id'), iNo = hdr.indexOf('audit_no'), iDate = hdr.indexOf('audit_date'),
        iWin = hdr.indexOf('window_days'), iPostDays = hdr.indexOf('post_days');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p = parseCSVLine(lines[i]);
    const id = parseInt(p[iStore], 10), no = parseInt(p[iNo], 10);
    const date = p[iDate], win = parseInt(p[iWin], 10), postDays = parseInt(p[iPostDays], 10);
    if (!Number.isFinite(id) || !Number.isFinite(no) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const addDays = (dstr, n) => {
      const d = new Date(dstr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    // pre = win days before the audit date; post = audit date → next audit date (exclusive),
    // or postDays from the audit date for the last audit (audit date → TODAY, inclusive)
    const preFrom = addDays(date, -win), preTo = date;
    const postFrom = date;
    const postTo = postDays > 0 ? addDays(date, postDays) : date; // postTo exclusive
    if (!windows.has(id)) windows.set(id, new Map());
    windows.get(id).set(no, { preFrom, preTo, postFrom, postTo });
  }
}

// ---------- claims by bucket per window ----------
const claims = new Map(); // id -> [{date, bucket}]
{
  const lines = fs.readFileSync(BUCKET_CSV, 'utf8').trim().split(/\r?\n/);
  const hdr = parseCSVLine(lines[0]);
  const iDT = hdr.indexOf('DT'), iStore = hdr.indexOf('STORE_ID'), iReason = hdr.indexOf('REASON'), iBucket = hdr.indexOf('BUCKET');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const p = parseCSVLine(lines[i]);
    const id = parseInt(p[iStore], 10);
    if (!Number.isFinite(id) || !windows.has(id)) continue;
    const dt = p[iDT];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
    const reason = p[iReason].trim();
    let bucket = p[iBucket].trim();
    const mapped = reasonBucket[reason];
    if (mapped && mapped !== bucket) bucket = mapped;
    if (!claims.has(id)) claims.set(id, []);
    claims.get(id).push({ date: dt, bucket });
  }
}

// ---------- FnV orders per window (from dashboard_data.js DAILY + AUDITED_DAILY) ----------
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'dashboard_data.js'), 'utf8'), ctx);
const dailyByStore = new Map(); // id -> Map(date -> tot)
vm.runInContext('DAILY', ctx).forEach(r => {
  if (!dailyByStore.has(r[0])) dailyByStore.set(r[0], new Map());
  dailyByStore.get(r[0]).set(r[1], (dailyByStore.get(r[0]).get(r[1]) || 0) + r[2]);
});
// AUDITED_DAILY is the audited-pod subset of DAILY in this build, but sum defensively
vm.runInContext('AUDITED_DAILY', ctx).forEach(r => {
  if (!dailyByStore.has(r[0])) dailyByStore.set(r[0], new Map());
  const m = dailyByStore.get(r[0]);
  m.set(r[1], (m.get(r[1]) || 0) + r[2]);
});

function ordersIn(id, from, toExcl) {
  const m = dailyByStore.get(id);
  if (!m) return 0;
  let tot = 0;
  m.forEach((v, date) => { if (date >= from && date < toExcl) tot += v; });
  return tot;
}

// ---------- assemble rows ----------
// BUCKETS fixed order for column stability
const BUCKETS = ['Pod', 'CX', 'Sourcing', 'WH'];
const rows = [];
windows.forEach((byNo, id) => {
  const cl = claims.get(id) || [];
  byNo.forEach((w, no) => {
    const pre = {}; const post = {};
    BUCKETS.forEach(b => { pre[b] = 0; post[b] = 0; });
    let preOther = 0, postOther = 0;
    cl.forEach(c => {
      if (c.date >= w.preFrom && c.date < w.preTo) {
        if (pre[c.bucket] != null) pre[c.bucket]++; else preOther++;
      } else if (c.date >= w.postFrom && c.date < w.postTo) {
        if (post[c.bucket] != null) post[c.bucket]++; else postOther++;
      }
    });
    // include unknown buckets in the row if any appeared
    if (preOther || postOther) pre.__other__ = preOther, post.__other__ = postOther;
    rows.push([
      id, no,
      BUCKETS.map(b => pre[b]),
      BUCKETS.map(b => post[b]),
      ordersIn(id, w.preFrom, w.preTo),
      ordersIn(id, w.postFrom, w.postTo),
    ]);
  });
});

const js = '// Auto-generated by build_rca_windows.js — do not edit by hand.\n' +
  '// One row per audited pod audit: [storeId, auditNo, preByBucket[Pod,CX,Sourcing,WH], postByBucket[same], preFnvOrders, postFnvOrders]\n' +
  '// Buckets within each pod\'s audit windows (same shared-window rule as dashboard_data.js).\n' +
  'const RCA_WINDOWS = ' + JSON.stringify(rows) + ';\n' +
  'const RCA_WINDOW_BUCKETS = ' + JSON.stringify(BUCKETS) + ';\n';
fs.writeFileSync(path.join(ROOT, 'rca_windows_data.js'), js);

const withClaims = rows.filter(r => r[2].some(x => x) || r[3].some(x => x)).length;
console.log('rca_windows_data.js:', rows.length, 'audit rows (' + withClaims + ' with claims in windows)');
console.log('  stores:', windows.size);
