"""Audit Score vs IGCC analysis for FnV category."""
import json
import numpy as np
import pandas as pd

BASE = r"C:\Users\lavanya.sl\Documents\Audit Score - IGCC analysis"
AUDIT = BASE + r"\Audit response wide\Pod Audit Tool - Audit Responses (Wide) (2).csv"
IGCC = BASE + r"\Store IGCC\IGCC _Daily Summary - Store inc (1).csv"

# ---------- Audit data ----------
aud = pd.read_csv(AUDIT, encoding="utf-8-sig", low_memory=False)
aud.columns = [c.strip() for c in aud.columns]
aud["Store ID"] = pd.to_numeric(aud["Store ID"], errors="coerce").astype("Int64")
aud["Date"] = pd.to_datetime(aud["Date"], errors="coerce")
aud["Score %"] = pd.to_numeric(aud["Score %"], errors="coerce")
aud = aud.dropna(subset=["Store ID", "Date", "Score %"])
aud = aud.sort_values(["Store ID", "Date"]).reset_index(drop=True)

# rank audits per store (1st, 2nd, ...)
aud["Audit_No"] = aud.groupby("Store ID").cumcount() + 1
aud["Audit_Label"] = "Audit " + aud["Audit_No"].astype(str)

# FNV-section columns: the first 7 FNV question columns (before "(Score)" versions)
fnv_cols = [c for c in aud.columns if c.startswith("FNV") and not c.endswith("(Score)")
            and not c.startswith("FNV - Chiller Zone")
            and "Inward temperature record" not in c
            and not c.startswith("FNV - Is the inward")]
score_cols = [c for c in aud.columns if c.endswith("(Score)") and (c.startswith("FNV")
              and not c.startswith("FNV - Chiller Zone")
              and "Inward temperature record" not in c
              and not c.startswith("FNV - Is the inward"))]

def pct_compliant(row, cols):
    vals = []
    for c in cols:
        v = row.get(c)
        if pd.isna(v):
            continue
        vals.append(1.0 if str(v).strip() == "Compliance" else (0.5 if "Partial" in str(v) else 0.0))
    return round(100 * sum(vals) / len(vals), 1) if vals else None

aud["FNV_Compliance_Pct"] = aud.apply(lambda r: pct_compliant(r, fnv_cols), axis=1)

# ---------- IGCC data ----------
ig = pd.read_csv(IGCC)
ig["ORDER_DATE"] = pd.to_datetime(ig["ORDER_DATE"])
ig["STORE_ID"] = pd.to_numeric(ig["STORE_ID"], errors="coerce").astype("Int64")
for c in ("ORDERS_TOTAL", "ORDERS_IGCC"):
    ig[c] = pd.to_numeric(ig[c], errors="coerce")
ig = ig.dropna(subset=["STORE_ID"])
ig["QNP"] = ig["ORDERS_IGCC"] / ig["ORDERS_TOTAL"].replace(0, np.nan)

store_meta = ig.groupby("STORE_ID").agg(
    CITY=("CITY", "first"),
    CITY_2=("CITY_2", "first"),
    TIER=("TIER", "first"),
).reset_index()

daily_igcc = ig.groupby(["STORE_ID", "ORDER_DATE"]).agg(
    orders_total=("ORDERS_TOTAL", "sum"),
    orders_igcc=("ORDERS_IGCC", "sum"),
).reset_index()
daily_igcc["qnp"] = daily_igcc["orders_igcc"] / daily_igcc["orders_total"].replace(0, np.nan)

print(f"Audit rows: {len(aud)}, stores: {aud['Store ID'].nunique()}")
print(f"IGCC rows: {len(ig)}, stores: {daily_igcc['STORE_ID'].nunique()}")
print(f"IGCC date range: {ig['ORDER_DATE'].min().date()} -> {ig['ORDER_DATE'].max().date()}")

# ---------- Per-audit IGCC windows ----------
# Window length = gap between adjacent audits for that pod. E.g. 1st audit Sep 1,
# 2nd audit Sep 13 -> 12-day gap -> pre/post windows of 12 days for each audit.
# If the next audit hasn't happened yet (last audit so far), the window length is
# the days from the audit date up to today (the date the dashboard is viewed).

results = []
for store_id, grp in aud.groupby("Store ID"):
    g = daily_igcc[daily_igcc["STORE_ID"] == store_id].set_index("ORDER_DATE")
    if g.empty:
        continue
    audits = grp.sort_values("Date").drop_duplicates(subset=["Date"], keep="first")
    for i, (_, row) in enumerate(audits.iterrows(), start=1):
        a_date = row["Date"]
        nxt = audits[audits["Date"] > a_date]
        # gap-based window: distance to the next audit; if none yet, days elapsed
        # since the audit (so the "post" window stretches to the present)
        if not nxt.empty:
            gap = (nxt.iloc[0]["Date"] - a_date).days
        else:
            gap = (pd.Timestamp.today().normalize() - a_date).days
        gap = max(gap, 1)
        pre = g.loc[(g.index >= a_date - pd.Timedelta(days=gap)) & (g.index < a_date)]
        post = g.loc[(g.index > a_date) & (g.index <= a_date + pd.Timedelta(days=gap))]
        # guard: post window must not include the next audit date itself
        if not nxt.empty:
            post = post.loc[post.index < nxt.iloc[0]["Date"]]
        def agg(w):
            if w.empty:
                return (np.nan, np.nan, 0)
            tot = w["orders_total"].sum()
            igs = w["orders_igcc"].sum()
            return (igs / tot if tot > 0 else np.nan, tot, len(w))
        pre_qnp, pre_tot, pre_days = agg(pre)
        post_qnp, post_tot, post_days = agg(post)
        results.append({
            "store_id": int(store_id),
            "audit_no": i,
            "audit_date": a_date.strftime("%Y-%m-%d"),
            "city": grp["City"].iloc[0],
            "auditor": row.get("Auditor Name", ""),
            "score_pct": row.get("Score %"),
            "fnv_compliance": row.get("FNV_Compliance_Pct"),
            "pre_qnp": None if pd.isna(pre_qnp) else round(pre_qnp, 5),
            "post_qnp": None if pd.isna(post_qnp) else round(post_qnp, 5),
            "pre_orders": int(pre_tot) if pre_days else 0,
            "post_orders": int(post_tot) if post_days else 0,
            "pre_days": pre_days,
            "post_days": post_days,
        })

per_audit = pd.DataFrame(results)

# store-level summary: first vs last audit
store_rows = []
for store_id, grp in aud.groupby("Store ID"):
    g = grp.sort_values("Date")
    # count distinct audit dates only — same-day rows are duplicate submissions
    audits_dedup = g.drop_duplicates(subset=["Date"], keep="first")
    first = audits_dedup.iloc[0]
    last = audits_dedup.iloc[-1]
    s_meta = store_meta[store_meta["STORE_ID"] == store_id]
    city2 = s_meta["CITY_2"].iloc[0] if not s_meta.empty else ""
    tier = s_meta["TIER"].iloc[0] if not s_meta.empty else ""
    pa = per_audit[per_audit["store_id"] == store_id]
    store_rows.append({
        "store_id": int(store_id),
        "store_name": str(first.get("Store Name", "")),
        "city": first["City"],
        "city_2": city2,
        "tier": tier,
        "n_audits": len(audits_dedup),
        "audit1_date": first["Date"].strftime("%Y-%m-%d"),
        "audit1_score": first["Score %"],
        "audit1_fnv": first["FNV_Compliance_Pct"],
        "audit2_score": audits_dedup.iloc[1]["Score %"] if len(audits_dedup) > 1 else None,
        "audit2_fnv": audits_dedup.iloc[1]["FNV_Compliance_Pct"] if len(audits_dedup) > 1 else None,
        "audit_last_date": last["Date"].strftime("%Y-%m-%d"),
        "audit_last_score": last["Score %"],
        "audit1_pre_qnp": pa[pa["audit_no"] == 1]["pre_qnp"].values[0] if len(pa) else None,
        "audit1_post_qnp": pa[pa["audit_no"] == 1]["post_qnp"].values[0] if len(pa) else None,
        "audit2_pre_qnp": pa[pa["audit_no"] == 2]["pre_qnp"].values[0] if len(pa[pa["audit_no"] == 2]) else None,
        "audit2_post_qnp": pa[pa["audit_no"] == 2]["post_qnp"].values[0] if len(pa[pa["audit_no"] == 2]) else None,
    })

stores = pd.DataFrame(store_rows)
stores.to_csv(BASE + r"\store_summary.csv", index=False)
per_audit.to_csv(BASE + r"\per_audit_igcc.csv", index=False)

# daily IGCC for the audited stores only (for dashboard charts)
audited_ids = set(aud["Store ID"].unique())
daily_audited = daily_igcc[daily_igcc["STORE_ID"].isin(audited_ids)]
meta_map = store_meta.set_index("STORE_ID")
daily_audited = daily_audited.copy()
daily_audited["city_2"] = daily_audited["STORE_ID"].map(meta_map["CITY_2"])
daily_audited["tier"] = daily_audited["STORE_ID"].map(meta_map["TIER"])
daily_audited["audit_dates"] = daily_audited["STORE_ID"].map(
    aud.drop_duplicates(subset=["Store ID", "Date"])
    .groupby("Store ID")["Date"].apply(lambda s: [d.strftime("%Y-%m-%d") for d in sorted(s)])
)
daily_audited["ORDER_DATE"] = daily_audited["ORDER_DATE"].dt.strftime("%Y-%m-%d")
daily_audited.to_csv(BASE + r"\daily_igcc_audited.csv", index=False)

# ---------- Correlations ----------
out = {}
def corr(x, y):
    m = pd.notna(x) & pd.notna(y)
    if m.sum() < 3:
        return None
    return round(float(np.corrcoef(x[m], y[m])[0, 1]), 3)

out["corr_score_vs_pre_qnp"] = corr(per_audit["score_pct"].astype(float), per_audit["pre_qnp"].astype(float))
out["corr_score_vs_post_qnp"] = corr(per_audit["score_pct"].astype(float), per_audit["post_qnp"].astype(float))
s1 = stores.dropna(subset=["audit1_score"])
out["n_stores"] = int(len(s1))
out["avg_score_audit1"] = round(float(s1["audit1_score"].astype(float).mean()), 1)
s2 = stores.dropna(subset=["audit2_score"])
out["n_stores_2audits"] = int(len(s2))
out["avg_score_audit2"] = round(float(s2["audit2_score"].astype(float).mean()), 1)
out["avg_score_delta_1to2"] = round(float((s2["audit2_score"].astype(float) - s2["audit1_score"].astype(float)).mean()), 1)

# audit1 -> audit2: IGCC delta pre-audit1 vs post-audit2
both = stores.dropna(subset=["audit1_pre_qnp", "audit2_post_qnp"])
out["n_stores_full_windows"] = int(len(both))
out["avg_pre_qnp_1"] = round(float(both["audit1_pre_qnp"].astype(float).mean()), 4)
out["avg_post_qnp_2"] = round(float(both["audit2_post_qnp"].astype(float).mean()), 4)
out["corr_score1_vs_score2_delta"] = corr(s2["audit1_score"].astype(float), (s2["audit2_score"].astype(float) - s2["audit1_score"].astype(float)))

with open(BASE + r"\summary_stats.json", "w") as f:
    json.dump(out, f, indent=2)

print(json.dumps(out, indent=2))
print("Saved: store_summary.csv, per_audit_igcc.csv, daily_igcc_audited.csv, summary_stats.json")
