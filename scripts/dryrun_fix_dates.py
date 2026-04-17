import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import psycopg2

conn = psycopg2.connect(
    host='db.iaompeiokjxbffwehhrx.supabase.co', port=5432,
    dbname='postgres', user='postgres', password='4562rd77fms0vrIr',
    sslmode='require'
)
cur = conn.cursor()

print('=' * 70)
print('DRY RUN — fix created_at de leads/deals importados')
print('=' * 70)

# =============== LEADS ===============
print('\n[LEADS]')

cur.execute("""
    SELECT COUNT(*),
           MIN(data_cadastro), MAX(data_cadastro),
           MIN(created_at)::date, MAX(created_at)::date
    FROM leads
""")
total, mincad, maxcad, mincr, maxcr = cur.fetchone()
print(f'  Total na tabela: {total}')
print(f'  Range data_cadastro: {mincad} → {maxcad}')
print(f'  Range created_at:    {mincr} → {maxcr}')

cur.execute("""
    SELECT COUNT(*)
    FROM leads
    WHERE data_cadastro IS NOT NULL
      AND created_at < '2026-04-06'::timestamptz
      AND created_at::date <> data_cadastro
""")
(afetados,) = cur.fetchone()
print(f'  Serao afetados:      {afetados}')

cur.execute("""
    SELECT COUNT(*) FILTER (WHERE data_cadastro IS NULL),
           COUNT(*) FILTER (WHERE created_at >= '2026-04-06'::timestamptz),
           COUNT(*) FILTER (WHERE data_cadastro IS NOT NULL AND created_at::date = data_cadastro)
    FROM leads
""")
(sem_datacad, pos_import, ja_batem) = cur.fetchone()
print(f'  Protegidos (sem data_cadastro):       {sem_datacad}')
print(f'  Protegidos (criados apos 2026-04-06): {pos_import}')
print(f'  Protegidos (created_at ja = data_cad): {ja_batem}')

print('\n  Amostra (10 primeiros a serem afetados):')
cur.execute("""
    SELECT empresa, canal, data_cadastro, created_at::date
    FROM leads
    WHERE data_cadastro IS NOT NULL
      AND created_at < '2026-04-06'::timestamptz
      AND created_at::date <> data_cadastro
    ORDER BY data_cadastro
    LIMIT 10
""")
print(f'  {"empresa":30s} {"canal":12s} {"data_cadastro":13s} {"created_old":13s}')
for r in cur.fetchall():
    emp = (r[0] or '')[:30]
    print(f'  {emp:30s} {r[1]:12s} {str(r[2]):13s} {str(r[3]):13s}')

# =============== DEALS ===============
print('\n[DEALS]')

cur.execute("""
    SELECT COUNT(*),
           MIN(data_call), MAX(data_call),
           MIN(created_at)::date, MAX(created_at)::date
    FROM deals
""")
total, mindc, maxdc, mincr, maxcr = cur.fetchone()
print(f'  Total na tabela: {total}')
print(f'  Range data_call:  {mindc} → {maxdc}')
print(f'  Range created_at: {mincr} → {maxcr}')

cur.execute("""
    SELECT COUNT(*)
    FROM deals
    WHERE created_at < '2026-04-06'::timestamptz
""")
(candidatos,) = cur.fetchone()
print(f'  Candidatos (importados): {candidatos}')

cur.execute("""
    WITH deal_dates AS (
      SELECT
        d.id,
        d.created_at AS current_created_at,
        COALESCE(
          (SELECT MIN(r.data_reuniao)
             FROM reunioes r
             WHERE r.deal_id = d.id
                OR (r.lead_id = d.lead_id AND d.lead_id IS NOT NULL)),
          (d.data_call::timestamp + TIME '12:00:00') AT TIME ZONE 'America/Sao_Paulo',
          (d.data_fechamento::timestamp + TIME '12:00:00') AT TIME ZONE 'America/Sao_Paulo'
        ) AS new_created_at,
        CASE
          WHEN (SELECT MIN(r.data_reuniao)
                  FROM reunioes r
                  WHERE r.deal_id = d.id
                     OR (r.lead_id = d.lead_id AND d.lead_id IS NOT NULL)) IS NOT NULL
            THEN 'reuniao'
          WHEN d.data_call IS NOT NULL THEN 'data_call'
          WHEN d.data_fechamento IS NOT NULL THEN 'data_fechamento'
          ELSE 'sem_fonte'
        END AS fonte
      FROM deals d
      WHERE d.created_at < '2026-04-06'::timestamptz
    )
    SELECT fonte, COUNT(*)
    FROM deal_dates
    WHERE new_created_at IS NULL
       OR new_created_at::date <> current_created_at::date
    GROUP BY fonte
    ORDER BY COUNT(*) DESC
""")
print('  Afetados por fonte:')
for r in cur.fetchall():
    print(f'    {r[0]:17s} {r[1]}')

cur.execute("""
    WITH deal_dates AS (
      SELECT
        d.id, d.empresa, d.data_call, d.data_fechamento,
        d.created_at AS current_created_at,
        COALESCE(
          (SELECT MIN(r.data_reuniao)
             FROM reunioes r
             WHERE r.deal_id = d.id
                OR (r.lead_id = d.lead_id AND d.lead_id IS NOT NULL)),
          (d.data_call::timestamp + TIME '12:00:00') AT TIME ZONE 'America/Sao_Paulo',
          (d.data_fechamento::timestamp + TIME '12:00:00') AT TIME ZONE 'America/Sao_Paulo'
        ) AS new_created_at
      FROM deals d
      WHERE d.created_at < '2026-04-06'::timestamptz
    )
    SELECT empresa, data_call, data_fechamento,
           current_created_at::date, new_created_at::date
    FROM deal_dates
    WHERE new_created_at IS NOT NULL
      AND new_created_at::date <> current_created_at::date
    ORDER BY new_created_at
    LIMIT 10
""")
print('\n  Amostra (10 primeiros a serem afetados):')
print(f'  {"empresa":30s} {"data_call":11s} {"data_fech":11s} {"old":11s} {"new":11s}')
for r in cur.fetchall():
    emp = (r[0] or '')[:30]
    print(f'  {emp:30s} {str(r[1] or "-"):11s} {str(r[2] or "-"):11s} {str(r[3]):11s} {str(r[4]):11s}')

cur.execute("""
    WITH deal_dates AS (
      SELECT d.id,
        COALESCE(
          (SELECT MIN(r.data_reuniao) FROM reunioes r
             WHERE r.deal_id = d.id OR r.lead_id = d.lead_id),
          d.data_call::timestamptz,
          d.data_fechamento::timestamptz
        ) AS new_dt
      FROM deals d
      WHERE d.created_at < '2026-04-06'::timestamptz
    )
    SELECT COUNT(*) FROM deal_dates WHERE new_dt IS NULL
""")
(sem_fonte,) = cur.fetchone()
print(f'\n  Deals sem nenhuma fonte de data (ficarao como estao): {sem_fonte}')

cur.close()
conn.close()
print('\n' + '=' * 70)
print('DRY RUN concluido. Nenhum dado foi alterado.')
print('=' * 70)
