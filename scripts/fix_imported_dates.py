import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import psycopg2
from datetime import datetime

conn = psycopg2.connect(
    host='db.iaompeiokjxbffwehhrx.supabase.co', port=5432,
    dbname='postgres', user='postgres', password='4562rd77fms0vrIr',
    sslmode='require'
)
conn.autocommit = False  # Transacao manual
cur = conn.cursor()

ts = datetime.now().strftime('%Y%m%d_%H%M%S')
leads_backup = f'leads_backup_{ts}'
deals_backup = f'deals_backup_{ts}'

try:
    print('=' * 70)
    print(f'FIX created_at dos registros importados — {ts}')
    print('=' * 70)

    # =========== BACKUP ===========
    print(f'\n[1/4] Criando backups...')
    cur.execute(f'CREATE TABLE {leads_backup} AS SELECT * FROM leads')
    cur.execute(f'CREATE TABLE {deals_backup} AS SELECT * FROM deals')
    cur.execute(f'SELECT COUNT(*) FROM {leads_backup}')
    (bk_leads,) = cur.fetchone()
    cur.execute(f'SELECT COUNT(*) FROM {deals_backup}')
    (bk_deals,) = cur.fetchone()
    print(f'  {leads_backup}: {bk_leads} rows')
    print(f'  {deals_backup}: {bk_deals} rows')

    # =========== UPDATE LEADS ===========
    print(f'\n[2/4] Atualizando leads...')
    cur.execute("""
        UPDATE leads
        SET created_at = (data_cadastro::timestamp + TIME '12:00:00') AT TIME ZONE 'America/Sao_Paulo'
        WHERE data_cadastro IS NOT NULL
          AND created_at < '2026-04-06'::timestamptz
          AND created_at::date <> data_cadastro
    """)
    leads_updated = cur.rowcount
    print(f'  Leads atualizados: {leads_updated}')

    # =========== UPDATE DEALS ===========
    print(f'\n[3/4] Atualizando deals...')
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
            ) AS new_created_at
          FROM deals d
          WHERE d.created_at < '2026-04-06'::timestamptz
        )
        UPDATE deals d
        SET created_at = dd.new_created_at
        FROM deal_dates dd
        WHERE d.id = dd.id
          AND dd.new_created_at IS NOT NULL
          AND dd.new_created_at::date <> dd.current_created_at::date
    """)
    deals_updated = cur.rowcount
    print(f'  Deals atualizados: {deals_updated}')

    # =========== VALIDACAO POS-UPDATE ===========
    print(f'\n[4/4] Validando resultado...')

    cur.execute("""
        SELECT MIN(created_at)::date, MAX(created_at)::date
        FROM leads WHERE data_cadastro IS NOT NULL
    """)
    lmin, lmax = cur.fetchone()
    print(f'  Leads created_at range (com data_cadastro): {lmin} -> {lmax}')

    cur.execute("""
        SELECT MIN(created_at)::date, MAX(created_at)::date
        FROM deals
    """)
    dmin, dmax = cur.fetchone()
    print(f'  Deals created_at range: {dmin} -> {dmax}')

    # Sanity check: nenhum lead com data_cadastro ficou com created_at > 2026-04-06 entre os candidatos
    cur.execute("""
        SELECT COUNT(*) FROM leads
        WHERE data_cadastro IS NOT NULL
          AND created_at::date <> data_cadastro
          AND created_at < '2026-04-06'::timestamptz
    """)
    (pendentes_leads,) = cur.fetchone()
    print(f'  Leads pendentes (deveria ser 0): {pendentes_leads}')

    print(f'\n[COMMIT] Confirmando transacao...')
    conn.commit()
    print('  OK — alteracoes persistidas.')

    print('\n' + '=' * 70)
    print('SUCESSO')
    print('=' * 70)
    print(f'Leads atualizados: {leads_updated}')
    print(f'Deals atualizados: {deals_updated}')
    print(f'Backups: {leads_backup} / {deals_backup}')
    print('\nSe precisar reverter:')
    print(f'  UPDATE leads l SET created_at = b.created_at FROM {leads_backup} b WHERE l.id = b.id;')
    print(f'  UPDATE deals d SET created_at = b.created_at FROM {deals_backup} b WHERE d.id = b.id;')

except Exception as e:
    conn.rollback()
    print(f'\n[ERRO] Transacao revertida. Nada foi alterado.')
    print(f'Erro: {e}')
    sys.exit(1)
finally:
    cur.close()
    conn.close()
