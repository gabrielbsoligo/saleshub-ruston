import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import requests

SUPABASE_ACCESS_TOKEN = 'sbp_fcd55fb1b8af31618c70c42b4303a24bf699a8c0'
PROJECT_REF = 'iaompeiokjxbffwehhrx'
API_BASE = f'https://api.supabase.com/v1/projects/{PROJECT_REF}/database/query'

def run_sql(sql: str, label: str = ''):
    if label:
        print(f'\n>> {label}')
    resp = requests.post(
        API_BASE,
        headers={
            'Authorization': f'Bearer {SUPABASE_ACCESS_TOKEN}',
            'Content-Type': 'application/json',
        },
        json={'query': sql},
        timeout=30,
    )
    if resp.status_code >= 400:
        print(f'   [ERRO {resp.status_code}]: {resp.text[:300]}')
        return None
    try:
        return resp.json()
    except Exception:
        return resp.text

print('=' * 70)
print('Aplicando migration_004_fk_delete_policies')
print('=' * 70)

# Le o SQL da migration
with open('supabase/migration_004_fk_delete_policies.sql', 'r', encoding='utf-8') as f:
    migration_sql = f.read()

# Remove comentarios de verificacao do final (o bloco /* ... */)
import re
migration_sql = re.sub(r'/\*.*?\*/', '', migration_sql, flags=re.DOTALL)

result = run_sql(migration_sql, 'Aplicando ALTER TABLE... DROP/ADD CONSTRAINT')
if result is not None:
    print('   OK — migration aplicada.')

# Verifica as rules
print()
verify = run_sql("""
    SELECT tc.table_name, kcu.column_name, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name IN ('deals', 'leads', 'reunioes')
    ORDER BY tc.table_name, kcu.column_name
""", 'Verificando delete rules apos migration')

if isinstance(verify, list):
    print(f'\n   FKs que referenciam deals/leads/reunioes:')
    print(f'   {"tabela":32s} {"coluna":22s} delete_rule')
    for r in verify:
        tbl = r.get('table_name', '?')
        col = r.get('column_name', '?')
        rule = r.get('delete_rule', '?')
        marker = '✓' if rule != 'NO ACTION' else '✗'
        print(f'   {marker} {tbl:30s} {col:22s} {rule}')

# Investigar Hebrom
print()
print('=' * 70)
print('Diagnostico Hebrom (duplicata)')
print('=' * 70)

hebrom = run_sql("""
    SELECT d.id::text AS id, d.status, d.reuniao_id::text AS reuniao_id,
           d.lead_id::text AS lead_id, d.created_at, d.kommo_id,
           d.valor_mrr, d.valor_ot,
           array_length(d.produtos_mrr, 1) AS n_prod_mrr,
           array_length(d.produtos_ot, 1) AS n_prod_ot
    FROM deals d
    WHERE d.empresa ILIKE '%hebrom%'
    ORDER BY d.created_at
""", 'Buscando deals do Hebrom')

if isinstance(hebrom, list):
    for r in hebrom:
        print(f"\n   deal_id:    {r['id']}")
        print(f"   status:     {r['status']}")
        print(f"   reuniao_id: {r['reuniao_id']}")
        print(f"   lead_id:    {r['lead_id']}")
        print(f"   kommo_id:   {r['kommo_id']}")
        print(f"   created:    {r['created_at']}")
        print(f"   valores:    MRR={r['valor_mrr']} OT={r['valor_ot']}")
        print(f"   produtos:   {r['n_prod_mrr']} MRR, {r['n_prod_ot']} OT")

# Reunioes associadas a cada deal
if isinstance(hebrom, list) and len(hebrom) >= 2:
    ids = [r['id'] for r in hebrom]
    ids_sql = ','.join(f"'{i}'" for i in ids)
    reunioes = run_sql(f"""
        SELECT r.id::text AS id, r.deal_id::text AS deal_id,
               r.lead_id::text AS lead_id, r.tipo, r.data_reuniao, r.realizada
        FROM reunioes r
        WHERE r.deal_id IN ({ids_sql})
           OR r.lead_id IN (SELECT lead_id FROM deals WHERE id IN ({ids_sql}) AND lead_id IS NOT NULL)
        ORDER BY r.data_reuniao
    """, 'Reunioes relacionadas')

    if isinstance(reunioes, list):
        print(f'\n   Total reunioes relacionadas: {len(reunioes)}')
        for r in reunioes:
            print(f"     reuniao {r['id'][:8]}... deal={r['deal_id'][:8] if r['deal_id'] else 'NULL':8} tipo={r['tipo']:13s} data={r['data_reuniao']} realizada={r['realizada']}")

print()
print('=' * 70)
print('Concluido')
print('=' * 70)
