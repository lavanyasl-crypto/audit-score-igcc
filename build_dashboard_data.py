"""Generate dashboard_data.js with embedded analysis results."""
import json
import pandas as pd

BASE = r"C:\Users\lavanya.sl\Documents\Audit Score - IGCC analysis"

stores = pd.read_csv(BASE + r"\store_summary.csv")
per_audit = pd.read_csv(BASE + r"\per_audit_igcc.csv")
daily = pd.read_csv(BASE + r"\daily_igcc_audited.csv")

# Store-level payload (compact: [id, name, city, city2, tier, n_audits, a1_date, a1_score, a1_fnv, a2_score, a2_fnv, a1pre, a1post, a2pre, a2post])
store_payload = []
for _, r in stores.iterrows():
    store_payload.append([
        int(r["store_id"]),
        str(r.get("store_name", "")),
        str(r["city"]),
        str(r["city_2"]),
        str(r["tier"]),
        int(r["n_audits"]),
        str(r["audit1_date"]),
        None if pd.isna(r["audit1_score"]) else float(r["audit1_score"]),
        None if pd.isna(r["audit1_fnv"]) else float(r["audit1_fnv"]),
        None if pd.isna(r["audit2_score"]) else float(r["audit2_score"]),
        None if pd.isna(r["audit2_fnv"]) else float(r["audit2_fnv"]),
        None if pd.isna(r["audit1_pre_qnp"]) else float(r["audit1_pre_qnp"]),
        None if pd.isna(r["audit1_post_qnp"]) else float(r["audit1_post_qnp"]),
        None if pd.isna(r["audit2_pre_qnp"]) else float(r["audit2_pre_qnp"]),
        None if pd.isna(r["audit2_post_qnp"]) else float(r["audit2_post_qnp"]),
    ])

# Per-audit payload (compact arrays)
audit_payload = []
for _, r in per_audit.iterrows():
    audit_payload.append([
        int(r["store_id"]),
        int(r["audit_no"]),
        str(r["audit_date"]),
        str(r["city"]),
        str(r["auditor"]),
        None if pd.isna(r["score_pct"]) else float(r["score_pct"]),
        None if pd.isna(r["fnv_compliance"]) else float(r["fnv_compliance"]),
        None if pd.isna(r["pre_qnp"]) else float(r["pre_qnp"]),
        None if pd.isna(r["post_qnp"]) else float(r["post_qnp"]),
        int(r["pre_orders"]) if not pd.isna(r["pre_orders"]) else 0,
        int(r["post_orders"]) if not pd.isna(r["post_orders"]) else 0,
    ])

# Daily IGCC (compact arrays: [store_id, dateStr, orders_total, orders_igcc])
daily_records = []
for _, r in daily.iterrows():
    daily_records.append([
        int(r["STORE_ID"]),
        str(r["ORDER_DATE"]),
        int(r["orders_total"]) if not pd.isna(r["orders_total"]) else 0,
        int(r["orders_igcc"]) if not pd.isna(r["orders_igcc"]) else 0,
    ])

with open(BASE + r"\dashboard_data.js", "w", encoding="utf-8") as f:
    f.write("const STORES = ")
    json.dump(store_payload, f, separators=(",", ":"))
    f.write(";\nconst AUDITS = ")
    json.dump(audit_payload, f, separators=(",", ":"))
    f.write(";\nconst DAILY = ")
    json.dump(daily_records, f, separators=(",", ":"))
    f.write(";\n")

# Compact per-audit: same as audit_payload now (already arrays)
compact_audits = audit_payload

with open(BASE + r"\dashboard_data.js", "w", encoding="utf-8") as f:
    f.write("const STORES = ")
    json.dump(store_payload, f, separators=(",", ":"))
    f.write(";\nconst AUDITS = ")
    json.dump(compact_audits, f, separators=(",", ":"))
    f.write(";\nconst DAILY = ")
    json.dump(daily_records, f, separators=(",", ":"))
    f.write(";\n")

import os
print(f"dashboard_data.js: {os.path.getsize(BASE + r'\dashboard_data.js')/1024/1024:.1f} MB")
