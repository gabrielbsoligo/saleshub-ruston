# Importa a base do BI (só colunas de EMPRESA) para public.cases_base_v4 via PostgREST (service_role).
# Uso: python -I importar_cases.py [--dry]
import os, sys, csv, json, re, urllib.request, datetime
env = {}
for l in open(os.path.expanduser('~/.oraculo/segredos/saleshub.env'), encoding='utf-8'):
    if '=' in l and not l.startswith('#'):
        k, v = l.strip().split('=', 1); env[k] = v.strip('"').strip("'")
URL = env['SUPABASE_URL'].rstrip('/') + '/rest/v1/cases_base_v4'
KEY = env['SUPABASE_SERVICE_ROLE_KEY']
CSV = r'C:\Users\gabri\dev\_dados-central-cases\clientes_v4_powerbi_completo_2026-10-26.csv'
dry = '--dry' in sys.argv

def limpa(v):
    v = (v or '').strip()
    return None if v in ('', 'Sem preenchimento') else v
def data(ms):
    try: return datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc).date().isoformat()
    except Exception: return None
def num(v):
    try: return float(str(v).replace(',', '.'))
    except Exception: return None
def uf(estado):
    m = re.search(r'\(([A-Z]{2})\)', estado or '')
    return m.group(1) if m else None
def nome_de(cliente, cnpj):
    s = (cliente or '').strip()
    if cnpj and s.endswith(cnpj): s = s[: -len(cnpj)].rstrip(' -').strip()
    return re.sub(r'\s*-\s*[\d./-]{14,18}$', '', s).strip() or s

linhas = []
with open(CSV, encoding='utf-8-sig', newline='') as f:
    for r in csv.DictReader(f, delimiter=';'):
        try: idc = int(r['id_cliente'])
        except Exception: continue
        cnpj = limpa(r.get('cnpj'))
        linhas.append({
            'id_cliente': idc,
            'nome': nome_de(r.get('cliente'), cnpj) or f'cliente {idc}',
            'razao_social': limpa(r.get('razao_social')),
            'cnpj': cnpj,
            'cidade': limpa(r.get('cidade')),
            'estado': limpa(r.get('estado')),
            'uf': uf(r.get('estado')),
            'categoria': limpa(r.get('categoria_cliente')),
            'tier': limpa(r.get('tier')),
            'status': limpa(r.get('status')),
            'produto_origem': limpa(r.get('produto_origem')),
            'tipo_servico': limpa(r.get('tipo_servico')),
            'canal_origem': limpa(r.get('canal_origem_cliente')),
            'safra_assinatura': data(r.get('dt_safra_assinatura')),
            'safra_inicio': data(r.get('dt_safra_inicio_projeto')),
            'lt_meses': int(float(r['lt_cliente'])) if (r.get('lt_cliente') or '').strip() not in ('', 'Sem preenchimento') else None,
            'fee': num(r.get('nvlr_deal')),
        })
# dedupe por id (fica a última)
por_id = {l['id_cliente']: l for l in linhas}
linhas = list(por_id.values())
print('linhas válidas:', len(linhas), '| colunas:', sorted(linhas[0].keys()))
if dry: sys.exit(0)
ok = 0
for i in range(0, len(linhas), 1000):
    lote = linhas[i:i + 1000]
    req = urllib.request.Request(URL, data=json.dumps(lote).encode('utf-8'), method='POST', headers={
        'apikey': KEY, 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'})
    try:
        with urllib.request.urlopen(req, timeout=120) as x: ok += len(lote)
    except urllib.error.HTTPError as e:
        print('lote', i, 'HTTP', e.code, e.read().decode()[:300]); sys.exit(1)
print('importadas:', ok)
