import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import requests

TOKEN = 'sbp_c37ee014da0025181647a2b8d5ea661d4db18a0d'
def sql(q):
    r = requests.post(
        'https://api.supabase.com/v1/projects/iaompeiokjxbffwehhrx/database/query',
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'},
        json={'query': q}, timeout=30,
    )
    return r.json() if r.status_code < 400 else {'err': r.text}

SEP = '=' * 72

print(SEP); print('AUDITORIA COMPLETA - comissoes_registros'); print(SEP)

r = sql("SELECT COUNT(*) AS n FROM comissoes_registros")
print(f'\nTotal comissoes: {r[0]["n"]}')

r = sql("SELECT status_comissao, COUNT(*) AS n FROM comissoes_registros GROUP BY status_comissao ORDER BY n DESC")
print('Por status:')
for row in r:
    print(f'  {row["status_comissao"]}: {row["n"]}')

# [1] valor_comissao NAO bate com valor_base * percentual
print('\n' + SEP)
print('[1] valor_comissao NAO bate com (valor_base * percentual)')
print(SEP)
r = sql("""SELECT COUNT(*) AS n FROM comissoes_registros
           WHERE ABS(valor_comissao - (valor_base * percentual)) > 0.01""")
print(f'Divergentes: {r[0]["n"]}')
if r[0]["n"] > 0:
    r2 = sql("""SELECT empresa, role_comissao, tipo,
                       valor_base::text AS base, percentual::text AS pct,
                       valor_comissao::text AS calc,
                       (valor_base * percentual)::text AS esperado
                FROM comissoes_registros
                WHERE ABS(valor_comissao - (valor_base * percentual)) > 0.01
                LIMIT 10""")
    for row in r2:
        print(f'  {(row["empresa"] or "")[:25]:25s} | {row["role_comissao"]} {row["tipo"]} | base={row["base"]} pct={row["pct"]} | tem={row["calc"]} esperado={row["esperado"]}')

# [2] data_liberacao nao eh data_pgto + 30d
print('\n' + SEP)
print('[2] data_liberacao diferente de data_pgto + 30 dias')
print(SEP)
r = sql("""SELECT COUNT(*) AS n FROM comissoes_registros
           WHERE data_pgto IS NOT NULL AND data_liberacao IS NOT NULL
             AND data_liberacao != data_pgto + INTERVAL '30 days'""")
print(f'Divergentes: {r[0]["n"]}')

# [3] comissoes sem data_pgto
print('\n' + SEP)
print('[3] Comissoes SEM data_pgto (impossibilita saber quando liberar)')
print(SEP)
r = sql("SELECT COUNT(*) AS n FROM comissoes_registros WHERE data_pgto IS NULL")
print(f'Sem data_pgto: {r[0]["n"]}')

# [4] comissoes com member_id NULL
print('\n' + SEP)
print('[4] Comissoes sem member_id (FK nula)')
print(SEP)
r = sql("SELECT COUNT(*) AS n, STRING_AGG(DISTINCT member_name, ', ') AS names FROM comissoes_registros WHERE member_id IS NULL")
print(f'Sem member_id: {r[0]["n"]}')
if r[0]["n"] > 0:
    print(f'  member_names afetados: {r[0]["names"]}')

# [5] percentual = 0
print('\n' + SEP)
print('[5] Comissoes com percentual = 0 (regra da config faltou)')
print(SEP)
r = sql("""SELECT role_comissao, tipo, categoria, COUNT(*) AS n
           FROM comissoes_registros WHERE percentual = 0
           GROUP BY role_comissao, tipo, categoria ORDER BY n DESC""")
total = sum(row["n"] for row in r)
print(f'Com percentual=0: {total}')
for row in r:
    print(f'  {row["role_comissao"]} {row["tipo"]} ({row["categoria"]}): {row["n"]}')

# [6] deals ganhos sem comissao
print('\n' + SEP)
print('[6] Deals GANHOS sem NENHUMA comissao')
print(SEP)
r = sql("""SELECT COUNT(*) AS n FROM deals d
           WHERE d.status = 'contrato_assinado'
             AND NOT EXISTS (SELECT 1 FROM comissoes_registros c WHERE c.deal_id = d.id)""")
print(f'Total: {r[0]["n"]}')
r = sql("""SELECT
    COUNT(*) FILTER (WHERE closer_id IS NULL AND sdr_id IS NULL) AS sem_ninguem,
    COUNT(*) FILTER (WHERE closer_id IS NOT NULL AND sdr_id IS NULL) AS so_closer,
    COUNT(*) FILTER (WHERE closer_id IS NULL AND sdr_id IS NOT NULL) AS so_sdr,
    COUNT(*) FILTER (WHERE closer_id IS NOT NULL AND sdr_id IS NOT NULL) AS ambos,
    COUNT(*) FILTER (WHERE created_at < '2026-04-06'::timestamptz) AS importados,
    COUNT(*) FILTER (WHERE created_at >= '2026-04-06'::timestamptz) AS organicos
  FROM deals d WHERE d.status = 'contrato_assinado'
    AND NOT EXISTS (SELECT 1 FROM comissoes_registros c WHERE c.deal_id = d.id)""")
for row in r:
    print(f'  s/ closer nem sdr: {row["sem_ninguem"]}')
    print(f'  so closer (sem sdr): {row["so_closer"]}')
    print(f'  so sdr (sem closer): {row["so_sdr"]}')
    print(f'  com closer e sdr: {row["ambos"]}')
    print(f'  importados (created<06/04): {row["importados"]}')
    print(f'  organicos (created>=06/04): {row["organicos"]}')

# [7] comissoes orfas
print('\n' + SEP)
print('[7] Comissoes orfas (deal nao existe ou deal_id NULL)')
print(SEP)
r = sql("""SELECT COUNT(*) AS n FROM comissoes_registros c
           WHERE c.deal_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.id = c.deal_id)""")
print(f'Com deal_id apontando pra deal inexistente: {r[0]["n"]}')
r = sql("SELECT COUNT(*) AS n FROM comissoes_registros WHERE deal_id IS NULL")
print(f'Com deal_id NULL: {r[0]["n"]}')

# [8] duplicatas
print('\n' + SEP)
print('[8] Comissoes DUPLICADAS (mesma combinacao deal/member/role/tipo)')
print(SEP)
r = sql("""SELECT deal_id::text, member_id::text, role_comissao, tipo, COUNT(*) AS n,
             (SELECT empresa FROM deals WHERE id = deal_id) AS empresa
           FROM comissoes_registros WHERE deal_id IS NOT NULL
           GROUP BY deal_id, member_id, role_comissao, tipo
           HAVING COUNT(*) > 1 ORDER BY n DESC""")
total_dup = sum(row["n"] - 1 for row in r)
print(f'Duplicatas excedentes: {total_dup}')
for row in r[:15]:
    print(f'  {(row["empresa"] or "")[:25]:25s} | {row["role_comissao"]} {row["tipo"]} | {row["n"]}x')

# [9] comissao incompleta
print('\n' + SEP)
print('[9] Deals GANHOS com comissao INCOMPLETA (tem closer/sdr + valor mas sem coms)')
print(SEP)
r = sql("""
    WITH esperado AS (
      SELECT d.id, d.empresa, d.closer_id, d.sdr_id,
        COALESCE(d.valor_recorrente, d.valor_mrr, 0) AS mrr,
        COALESCE(d.valor_escopo, d.valor_ot, 0) AS ot
      FROM deals d WHERE d.status = 'contrato_assinado'
    ), reg AS (
      SELECT deal_id,
        COUNT(*) FILTER (WHERE role_comissao='closer' AND tipo='mrr') AS cc_mrr,
        COUNT(*) FILTER (WHERE role_comissao='closer' AND tipo='ot') AS cc_ot,
        COUNT(*) FILTER (WHERE role_comissao='sdr' AND tipo='mrr') AS cs_mrr,
        COUNT(*) FILTER (WHERE role_comissao='sdr' AND tipo='ot') AS cs_ot
      FROM comissoes_registros GROUP BY deal_id
    )
    SELECT COUNT(*) AS n FROM esperado e LEFT JOIN reg r ON r.deal_id = e.id
    WHERE (e.closer_id IS NOT NULL AND e.mrr > 0 AND COALESCE(r.cc_mrr,0) = 0)
       OR (e.closer_id IS NOT NULL AND e.ot > 0 AND COALESCE(r.cc_ot,0) = 0)
       OR (e.sdr_id IS NOT NULL AND e.mrr > 0 AND COALESCE(r.cs_mrr,0) = 0)
       OR (e.sdr_id IS NOT NULL AND e.ot > 0 AND COALESCE(r.cs_ot,0) = 0)
""")
print(f'Deals com comissao incompleta (faltou perna): {r[0]["n"]}')

# [10] member_name stale
print('\n' + SEP)
print('[10] member_name diferente do nome atual em team_members')
print(SEP)
r = sql("""SELECT COUNT(*) AS n FROM comissoes_registros c
           JOIN team_members tm ON tm.id = c.member_id
           WHERE c.member_name <> tm.name""")
print(f'member_name stale: {r[0]["n"]}')

# [11] comissoes de deals que nao estao mais ganhos
print('\n' + SEP)
print('[11] Comissoes de deals que HOJE NAO estao em contrato_assinado')
print(SEP)
r = sql("""SELECT c.empresa, d.status, COUNT(*) AS n, SUM(c.valor_comissao)::text AS total
           FROM comissoes_registros c JOIN deals d ON d.id = c.deal_id
           WHERE d.status != 'contrato_assinado'
           GROUP BY c.empresa, d.status ORDER BY c.empresa""")
total = sum(row["n"] for row in r)
print(f'Comissoes de deals "nao-ganhos": {total}')
for row in r[:15]:
    print(f'  {(row["empresa"] or "")[:30]:30s} | status={row["status"]:20s} | {row["n"]} coms | R$ {row["total"]}')

# [12] categoria vs origem inconsistente
print('\n' + SEP)
print('[12] Categoria da comissao NAO bate com origem do deal')
print(SEP)
r = sql("""SELECT COUNT(*) AS n FROM comissoes_registros c JOIN deals d ON d.id = c.deal_id
           WHERE (d.origem IN ('blackbox','leadbroker') AND c.categoria != 'inbound')
              OR (d.origem NOT IN ('blackbox','leadbroker') AND c.categoria != 'outbound')""")
print(f'Com categoria inconsistente com origem atual: {r[0]["n"]}')
if r[0]["n"] > 0:
    r2 = sql("""SELECT c.empresa, c.categoria AS cat, d.origem, COUNT(*) AS n
                FROM comissoes_registros c JOIN deals d ON d.id = c.deal_id
                WHERE (d.origem IN ('blackbox','leadbroker') AND c.categoria != 'inbound')
                   OR (d.origem NOT IN ('blackbox','leadbroker') AND c.categoria != 'outbound')
                GROUP BY c.empresa, c.categoria, d.origem LIMIT 10""")
    for row in r2:
        print(f'  {(row["empresa"] or "")[:25]:25s} | cat_com={row["cat"]} origem_deal={row["origem"]} ({row["n"]}x)')

# [13] closer/sdr divergente
print('\n' + SEP)
print('[13] Responsavel na comissao diferente do responsavel atual no deal')
print(SEP)
r = sql("""SELECT COUNT(*) AS n FROM comissoes_registros c JOIN deals d ON d.id = c.deal_id
           WHERE (c.role_comissao='closer' AND d.closer_id IS NOT NULL AND c.member_id != d.closer_id)
              OR (c.role_comissao='sdr' AND d.sdr_id IS NOT NULL AND c.member_id != d.sdr_id)""")
print(f'Com responsavel divergente: {r[0]["n"]}')

# [14] valor_comissao = 0
print('\n' + SEP)
print('[14] Comissoes com valor_comissao = 0')
print(SEP)
r = sql("SELECT COUNT(*) AS n FROM comissoes_registros WHERE valor_comissao = 0")
print(f'Com valor=0: {r[0]["n"]}')

# [15] Valor_base zero ou NULL
print('\n' + SEP)
print('[15] Comissoes com valor_base zero ou NULL (comissao sem base)')
print(SEP)
r = sql("SELECT COUNT(*) AS n FROM comissoes_registros WHERE valor_base IS NULL OR valor_base = 0")
print(f'Com valor_base invalido: {r[0]["n"]}')

print('\n' + SEP)
print('FIM')
print(SEP)
