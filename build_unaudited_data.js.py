"""Generate unaudited_data.js: per-pod pre/post IGCC for three groups —
not audited (control, pseudo audit date), 1 audit, 2+ audits.

Audited pods: pre = pre-window IGCC of 1st audit, post = post-window IGCC of
last audit (gap-based windows from analysis.py, via per_audit_igcc.csv).
Unaudited pods: pseudo audit date drawn uniformly from the audit period
(deterministic seed), 7-day pre/post windows — a control so seasonality
cancels out when comparing groups.
"""
import json
import numpy as np
import pandas as pd

BASE = r"C:\Users\lavanya.sl\Documents\Audit Score - IGCC analysis"
WIDE = BASE + r"\Audit response wide\Pod Audit Tool - Audit Responses (Wide).csv"
IGCC = BASE + r"\Store IGCC\IGCC _Daily Summary - Store inc (1).csv"
WINDOW_DAYS = 7
SEED = 42

aud = pd.read_csv(WIDE, encoding="utf-8-sig", low_memory=False)
aud.columns = [c.strip() for c in aud.columns]
aud["Store ID"] = pd.to_numeric(aud["Store ID"], errors="coerce").astype("Int64")
aud["Date"] = pd.to_datetime(aud["Date"], errors="coerce")
aud["Score %"] = pd.to_numeric(aud["Score %"], errors="coerce")
aud = aud.dropna(subset=["Store ID", "Date"])
aud = aud.sort_values(["Store ID", "Date"])

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

audit_dates = aud["Date"].dropna()
d_lo, d_hi = audit_dates.min(), audit_dates.max()

def window_qnp(g, a_date, days):
    pre = g.loc[(g.index >= a_date - pd.Timedelta(days=days)) & (g.index < a_date)]
    post = g.loc[(g.index > a_date) & (g.index <= a_date + pd.Timedelta(days=days))]
    def agg(w):
        if w.empty:
            return None
        tot = w["orders_total"].sum()
        return w["orders_igcc"].sum() / tot if tot > 0 else None
    return agg(pre), agg(post)

pa = pd.read_csv(BASE + r"\per_audit_igcc.csv")
pa["audit_date"] = pd.to_datetime(pa["audit_date"])
names = aud.groupby("Store ID")["Store Name"].agg(lambda s: s.dropna().iloc[0] if s.dropna().size else "")

rows = []

# --- audited pods: pre of 1st audit, post of last audit ---
for store_id, grp in pa.groupby("store_id"):
    grp = grp.sort_values("audit_no")
    first, last = grp.iloc[0], grp.iloc[-1]
    meta = store_meta[store_meta["STORE_ID"] == store_id]
    rows.append({
        "id": int(store_id),
        "n": int(grp["audit_no"].max()),
        "date": first["audit_date"].strftime("%Y-%m-%d"),
        "pre": first["pre_qnp"],
        "post": last["post_qnp"],
        "city2": meta["CITY_2"].iloc[0] if not meta.empty else "",
        "tier": meta["TIER"].iloc[0] if not meta.empty else "",
        "name": str(names.get(store_id, "")),
        "pseudo": False,
    })

# --- never-audited pods: pseudo audit date, 7-day windows ---
audited_ids = set(pa["store_id"].astype(int))
rng = np.random.default_rng(SEED)
never_ids = sorted(set(store_meta["STORE_ID"].astype(int)) - audited_ids)
for store_id in never_ids:
    g = daily_igcc[daily_igcc["STORE_ID"] == store_id].set_index("ORDER_DATE")
    meta = store_meta[store_meta["STORE_ID"] == store_id]
    pseudo = d_lo + pd.Timedelta(days=float(rng.integers(0, (d_hi - d_lo).days + 1)))
    pre, post = window_qnp(g, pseudo, WINDOW_DAYS)
    rows.append({
        "id": int(store_id),
        "n": 0,
        "date": pseudo.strftime("%Y-%m-%d"),
        "pre": pre,
        "post": post,
        "city2": meta["CITY_2"].iloc[0] if not meta.empty else "",
        "tier": meta["TIER"].iloc[0] if not meta.empty else "",
        "name": "",
        "pseudo": True,
    })

out = {"groups": rows}

def clean(v):
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    return v
for r in rows:
    r["pre"] = clean(r["pre"])
    r["post"] = clean(r["post"])

with open(BASE + r"\unaudited_data.js", "w", encoding="utf-8") as f:
    f.write("const AUDIT_GROUPS = ")
    json.dump(rows, f, separators=(",", ":"), ensure_ascii=False)
    f.write(";\n")

df = pd.DataFrame(rows)
df["grp"] = pd.cut(df["n"], [-1, 0, 1, 100], labels=["Not audited", "1 audit", "2+ audits"])
summ = df.groupby("grp", observed=True).agg(
    pods=("id", "count"), with_data=("pre", "count"),
    avg_pre=("pre", "mean"), avg_post=("post", "mean"))
summ["delta_pp"] = (summ["avg_post"] - summ["avg_pre"]) * 100
print(summ.to_string())
print(f"unaudited_data.js: {len(rows)} pods")
