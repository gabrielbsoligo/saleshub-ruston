import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import psycopg2

conn = psycopg2.connect(
    host='aws-0-sa-east-1.pooler.supabase.com', port=6543,
    dbname='postgres', user='postgres.iaompeiokjxbffwehhrx', password='4562rd77fms0vrIr',
    sslmode='require'
)
cur = conn.cursor()

# 1. Todas as FKs que apontam pra deals (e suas delete rules)
print('=' * 70)
print('FKs que referenciam deals')
print('=' * 70)
cur.execute("""
    SELECT
        tc.table_name AS tabela,
        kcu.column_name AS coluna,
        rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'deals'
    ORDER BY tc.table_name, kcu.column_name
""")
for r in cur.fetchall():
    print(f'  {r[0]:30s}.{r[1]:15s} ON DELETE {r[2]}')

# 2. FKs que apontam pra leads
print()
print('=' * 70)
print('FKs que referenciam leads')
print('=' * 70)
cur.execute("""
    SELECT
        tc.table_name, kcu.column_name, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'leads'
    ORDER BY tc.table_name
""")
for r in cur.fetchall():
    print(f'  {r[0]:30s}.{r[1]:15s} ON DELETE {r[2]}')

# 3. FKs que apontam pra reunioes
print()
print('=' * 70)
print('FKs que referenciam reunioes')
print('=' * 70)
cur.execute("""
    SELECT tc.table_name, kcu.column_name, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'reunioes'
    ORDER BY tc.table_name
""")
for r in cur.fetchall():
    print(f'  {r[0]:30s}.{r[1]:15s} ON DELETE {r[2]}')

# 4. Investigar o Hebrom duplicado
print()
print('=' * 70)
print('Caso Hebrom (duplicata)')
print('=' * 70)
cur.execute("""
    SELECT id, empresa, status, kommo_id, reuniao_id, lead_id, created_at
    FROM deals
    WHERE empresa ILIKE '%hebrom%'
    ORDER BY created_at
""")
for r in cur.fetchall():
    print(f'  deal_id={r[0]} | status={r[2]:15s} | kommo={r[3]} | reuniao_id={r[4]} | lead_id={r[5]} | {r[6]}')

# Quais automations apontam pros deals do Hebrom?
print()
cur.execute("""
    SELECT pma.id, pma.deal_id, pma.reuniao_id, pma.status, pma.created_at
    FROM post_meeting_automations pma
    WHERE pma.deal_id IN (SELECT id FROM deals WHERE empresa ILIKE '%hebrom%')
    ORDER BY pma.created_at
""")
print('  post_meeting_automations do Hebrom:')
for r in cur.fetchall():
    print(f'    pma_id={r[0]} | deal_id={r[1]} | reuniao_id={r[2]} | status={r[3]} | {r[4]}')

# Verificar quantas reunioes cada deal tem
print()
cur.execute("""
    SELECT d.id, d.status, COUNT(r.id) AS reunioes_vinculadas
    FROM deals d
    LEFT JOIN reunioes r ON r.deal_id = d.id
    WHERE d.empresa ILIKE '%hebrom%'
    GROUP BY d.id, d.status
""")
for r in cur.fetchall():
    print(f'  deal={r[0]} status={r[1]:15s} reunioes_vinculadas={r[2]}')

# 5. Quantos orfaos potenciais existem hoje (deals sem reuniao_id, deals onde a reuniao nao referencia de volta)
print()
print('=' * 70)
print('Higiene geral')
print('=' * 70)
cur.execute("SELECT COUNT(*) FROM deals d WHERE NOT EXISTS (SELECT 1 FROM reunioes r WHERE r.deal_id = d.id OR r.id = d.reuniao_id)")
(deals_sem_reuniao,) = cur.fetchone()
print(f'  Deals sem nenhuma reuniao vinculada: {deals_sem_reuniao}')

cur.execute("SELECT COUNT(*) FROM post_meeting_automations")
(total_pma,) = cur.fetchone()
print(f'  Total post_meeting_automations: {total_pma}')

cur.close()
conn.close()
