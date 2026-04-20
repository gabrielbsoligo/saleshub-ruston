import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import requests

TOKEN = 'sbp_fcd55fb1b8af31618c70c42b4303a24bf699a8c0'
PROJECT_REF = 'iaompeiokjxbffwehhrx'
API = f'https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query'

def sql(q):
    r = requests.post(API, headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'},
                      json={'query': q}, timeout=30)
    if r.status_code >= 400:
        print(f'ERROR {r.status_code}: {r.text[:300]}')
        return None
    return r.json()

print('=' * 70)
print('LEADS recentes que foram criados no SalesHub e replicados no Kommo')
print('=' * 70)

# Leads criados organicamente (apos 06/04) que tem kommo_id
res = sql("""
    SELECT id::text, empresa, canal, kommo_id, kommo_request_id, created_at
    FROM leads
    WHERE created_at > '2026-04-06'::timestamptz
      AND kommo_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 10
""")
for r in res or []:
    print(f"  {r['created_at'][:19]} | {r['empresa'][:30]:30s} | canal={r['canal']:13s} | kommo_id={r['kommo_id']}")

print()
print('=' * 70)
print('Response que Kommo devolveu pros ultimos 3 (ver se origem foi aceita)')
print('=' * 70)

# Pega os IDs dos mais recentes que tem kommo_request_id
res2 = sql("""
    SELECT l.id::text AS lead_id, l.empresa, l.canal, l.kommo_id, l.kommo_request_id
    FROM leads l
    WHERE l.created_at > '2026-04-06'::timestamptz
      AND l.kommo_id IS NOT NULL
    ORDER BY l.created_at DESC
    LIMIT 3
""")
for r in res2 or []:
    print(f"\n>> Lead: {r['empresa']} (canal={r['canal']}, kommo_id={r['kommo_id']})")
    # Vai no Kommo API via trigger ver o lead atual
    pass

# Ver o que o Kommo retorna agora pro lead mais recente
if res2 and len(res2) > 0:
    recent = res2[0]
    kid = recent['kommo_id']
    print(f'\n\nBuscando lead {kid} no Kommo API direto...')
    token = sql("SELECT value FROM integracao_config WHERE key = 'kommo_access_token'")
    access_token = token[0]['value'] if token else None
    if access_token:
        kresp = requests.get(
            f'https://financeirorustonengenhariacombr.kommo.com/api/v4/leads/{kid}',
            headers={'Authorization': f'Bearer {access_token}'},
            timeout=15
        )
        if kresp.status_code == 200:
            lead_data = kresp.json()
            cfs = lead_data.get('custom_fields_values') or []
            print(f'\n   Custom fields preenchidos no Kommo:')
            for cf in cfs:
                fid = cf.get('field_id')
                fname = cf.get('field_name')
                vals = cf.get('values', [])
                val_str = ', '.join(str(v.get('value') or v.get('enum_id') or v.get('enum_code')) for v in vals)
                marker = '  <-- ORIGEM' if fid == 975168 else ''
                print(f'     field_id={fid:>8} | {fname}: {val_str}{marker}')

            has_origem = any(cf.get('field_id') == 975168 for cf in cfs)
            print(f'\n   Origem (975168) preenchida? {"SIM" if has_origem else "NAO ❌"}')
        else:
            print(f'   Kommo retornou {kresp.status_code}: {kresp.text[:200]}')

print()
print('=' * 70)
print('Sanity check: source da function sync_lead_to_kommo')
print('=' * 70)
src = sql("SELECT prosrc FROM pg_proc WHERE proname = 'sync_lead_to_kommo'")
if src:
    s = src[0]['prosrc']
    # Extrair so o bloco do origem
    import re
    m = re.search(r'origem_enum_id\s*:=.*?END;', s, re.DOTALL)
    if m:
        print(m.group(0)[:500])
    # Verifica se ainda usa field_id 975168
    if '975168' in s:
        print('\n   field_id 975168 PRESENTE no trigger')
    else:
        print('\n   field_id 975168 AUSENTE no trigger')
