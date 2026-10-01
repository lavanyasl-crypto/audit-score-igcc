"""Generate param_data.js: per-audit parameter scores (0/1/2) + IGCC windows + city/tier."""
import json
import numpy as np
import pandas as pd

BASE = r"C:\Users\lavanya.sl\Documents\Audit Score - IGCC analysis"
WIDE = BASE + r"\Audit response wide\Pod Audit Tool - Audit Responses (Wide).csv"
IGCC = BASE + r"\Store IGCC\IGCC _Daily Summary - Store inc (1).csv"
WINDOW_DAYS = 14

aud = pd.read_csv(WIDE, encoding="utf-8-sig", low_memory=False)
aud.columns = [c.strip() for c in aud.columns]
aud["Store ID"] = pd.to_numeric(aud["Store ID"], errors="coerce").astype("Int64")
aud["Date"] = pd.to_datetime(aud["Date"], errors="coerce")
aud["Score %"] = pd.to_numeric(aud["Score %"], errors="coerce")
aud = aud.dropna(subset=["Store ID", "Date", "Score %"])
aud = aud.sort_values(["Store ID", "Date"]).reset_index(drop=True)
aud["Audit_No"] = aud.groupby("Store ID").cumcount() + 1

# parameter score columns (exclude section-rollup pseudo-params)
score_cols = [c for c in aud.columns if c.endswith(" (Score)")
              and not c.startswith("FNV - Chiller Zone")
              and "Inward temperature record" not in c
              and not c.startswith("FNV - Is the inward")
              and c != "Result (Score)"
              and not c.endswith("Questions Completed (Score)")]
params = [c[:-len(" (Score)")] for c in score_cols]
print(f"audits: {len(aud)}, parameters: {len(params)}")

# IGCC
ig = pd.read_csv(IGCC)
ig["ORDER_DATE"] = pd.to_datetime(ig["ORDER_DATE"])
ig["STORE_ID"] = pd.to_numeric(ig["STORE_ID"], errors="coerce").astype("Int64")
for c in ("ORDERS_TOTAL", "ORDERS_IGCC"):
    ig[c] = pd.to_numeric(ig[c], errors="coerce")
ig = ig.dropna(subset=["STORE_ID"])
daily_igcc = ig.groupby(["STORE_ID", "ORDER_DATE"]).agg(
    orders_total=("ORDERS_TOTAL", "sum"), orders_igcc=("ORDERS_IGCC", "sum")).reset_index()
daily_igcc["qnp"] = daily_igcc["orders_igcc"] / daily_igcc["orders_total"].replace(0, np.nan)
store_meta = ig.groupby("STORE_ID").agg(CITY_2=("CITY_2", "first"), TIER=("TIER", "first")).reset_index()

# per-audit IGCC windows
results = []
for store_id, grp in aud.groupby("Store ID"):
    g = daily_igcc[daily_igcc["STORE_ID"] == store_id].set_index("ORDER_DATE")
    meta = store_meta[store_meta["STORE_ID"] == store_id]
    city2 = meta["CITY_2"].iloc[0] if not meta.empty else ""
    tier = meta["TIER"].iloc[0] if not meta.empty else ""
    audits = grp.sort_values("Date").drop_duplicates(subset=["Date"], keep="first")
    for i, (_, row) in enumerate(audits.iterrows(), start=1):
        a_date = row["Date"]
        pre = g.loc[(g.index >= a_date - pd.Timedelta(days=WINDOW_DAYS)) & (g.index < a_date)]
        post = g.loc[(g.index > a_date) & (g.index <= a_date + pd.Timedelta(days=WINDOW_DAYS))]
        nxt = audits[audits["Date"] > a_date]
        if not nxt.empty:
            post = post.loc[post.index < nxt.iloc[0]["Date"]]
        def agg(w):
            if w.empty:
                return np.nan
            tot = w["orders_total"].sum()
            return w["orders_igcc"].sum() / tot if tot > 0 else np.nan
        pre_qnp, post_qnp = agg(pre), agg(post)
        scores = []
        for sc in score_cols:
            v = row.get(sc)
            scores.append(None if pd.isna(v) else int(v))
        results.append({
            "store_id": int(store_id), "audit_no": i,
            "audit_date": a_date.strftime("%Y-%m-%d"),
            "city": str(row.get("City", "")), "city2": city2, "tier": tier,
            "auditor": str(row.get("Auditor Name", "")),
            "score_pct": float(row["Score %"]),
            "pre_qnp": None if pd.isna(pre_qnp) else round(pre_qnp, 5),
            "post_qnp": None if pd.isna(post_qnp) else round(post_qnp, 5),
            "scores": scores,
        })

# PARAMS list (short labels) — derive zone prefix from section before " - "
out = {"params": params, "audits": results}
with open(BASE + r"\param_data.js", "w", encoding="utf-8") as f:
    f.write("const PARAM_NAMES = ")
    json.dump(params, f, separators=(",", ":"), ensure_ascii=False)
    f.write(";\nconst PARAM_AUDITS = ")
    json.dump(results, f, separators=(",", ":"), ensure_ascii=False)
    f.write(";\n")

import os
print(f"param_data.js: {os.path.getsize(BASE + r'\param_data.js')/1024/1024:.1f} MB, audit rows: {len(results)}")
