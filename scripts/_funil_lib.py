"""Read-only helper: run SQL against Supabase via Management API. Analysis only."""
import os, json, time, sys
import requests

REF = os.environ.get("SB_REF", "iaompeiokjxbffwehhrx")
TOKEN = os.environ["SB_TOKEN"]
URL = f"https://api.supabase.com/v1/projects/{REF}/database/query"
HEAD = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# minimal guard: this module is for SELECTs only
_FORBIDDEN = ("insert ", "update ", "delete ", "drop ", "alter ", "truncate ",
              "create ", "grant ", "revoke ")

def run(sql, retries=4):
    low = sql.strip().lower()
    if not (low.startswith("select") or low.startswith("with")):
        raise ValueError("read-only: only SELECT/WITH allowed")
    if any(tok in low for tok in _FORBIDDEN):
        raise ValueError(f"read-only guard tripped: {sql[:80]}")
    last = None
    for i in range(retries):
        try:
            r = requests.post(URL, headers=HEAD, json={"query": sql}, timeout=60)
            if r.status_code in (200, 201):
                return r.json()
            last = f"HTTP {r.status_code}: {r.text[:300]}"
        except Exception as e:
            last = repr(e)
        time.sleep(2 ** i)
    raise RuntimeError(f"query failed after {retries} tries: {last}\nSQL: {sql[:200]}")

if __name__ == "__main__":
    print(json.dumps(run(sys.argv[1]), indent=2, default=str))
