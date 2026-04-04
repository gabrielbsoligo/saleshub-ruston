import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import pandas as pd
import psycopg2
from datetime import datetime

conn = psycopg2.connect(host='db.iaompeiokjxbffwehhrx.supabase.co', port=5432, dbname='postgres', user='postgres', password='4562rd77fms0vrIr', sslmode='require')
conn.autocommit = True
cur = conn.cursor()

cur.execute('SELECT id, name FROM team_members')
members = {}
for r in cur.fetchall():
    members[r[1]] = str(r[0])
    members[r[1].split(' ')[0]] = str(r[0])
members['Jenni'] = members.get('Jenniffer', '')
members['Ricardo'] = members.get('Ricardo Matheus Costa', '')
members['Adriano'] = members.get('Adriano Ramos Burger', '')
members['Gabrielli'] = members.get('Gabrielli Estevão Nene', '')

status_map = {
    'Contrato Assinado': 'contrato_assinado', 'Perdido': 'perdido',
    'Follow Longo': 'follow_longo', 'Negociação': 'negociacao',
    'Contrato na Rua': 'contrato_na_rua',
}
origem_map = {
    'OUTBOUND': 'outbound', 'Black Box': 'blackbox', 'RECOMENDAÇÃO': 'recomendacao',
    'INDICAÇÃO': 'indicacao', 'LEADBROKER': 'leadbroker', 'NETWORKING': 'outbound',
    'THUNDERBOLT': 'outbound', 'MVP USA': 'outbound', 'EVENTO': 'outbound', 'Food Box': 'blackbox',
}
temp_map = {'Quente': 'quente', 'Morno': 'morno', 'Frio': 'frio'}

# March deals with corrected SDR + payment dates
march_overrides = {
    'Ferravima': {'sdr': None, 'pgto_ot': '2026-04-07', 'pgto_mrr': None},
    'Credit Saint German': {'sdr': 'Lary', 'pgto_ot': '2026-03-26', 'pgto_mrr': '2026-04-23'},
    'Ok Geradores': {'sdr': 'Lary', 'pgto_ot': '2026-03-26', 'pgto_mrr': '2026-04-23'},
    'Hércules Empilhadeiras': {'sdr': 'Lary', 'pgto_ot': '2026-04-13', 'pgto_mrr': '2026-04-23'},
    'UAI Autopeças': {'sdr': 'Lary', 'pgto_ot': '2026-03-25', 'pgto_mrr': None},
    'Triload': {'sdr': None, 'pgto_ot': '2026-03-20', 'pgto_mrr': None},  # Bruno operacao - manual
    'Science Valley': {'sdr': 'Luiz', 'pgto_ot': '2026-03-05', 'pgto_mrr': '2026-03-23'},
    'Lumiére Noivas': {'sdr': 'Lary', 'pgto_ot': '2026-04-06', 'pgto_mrr': '2026-04-16'},
    'Moto Alfa': {'sdr': None, 'pgto_ot': '2026-03-10', 'pgto_mrr': '2026-03-10'},
    'Agua de Coco Ice': {'sdr': 'Lary', 'pgto_ot': '2026-03-13', 'pgto_mrr': '2026-04-10'},
    'Dubai Comércio': {'sdr': None, 'pgto_ot': '2026-03-16', 'pgto_mrr': '2026-04-10'},  # Giuseppe - manual
    'Implacil Osstem': {'sdr': None, 'pgto_ot': '2026-02-26', 'pgto_mrr': '2026-02-25'},
    'Campo Vale': {'sdr': None, 'pgto_ot': '2026-03-06', 'pgto_mrr': None},  # 50% Nathan - manual
    'Amazon Nautica': {'sdr': 'Lary', 'pgto_ot': '2026-03-05', 'pgto_mrr': None},
    'Zonaro Store': {'sdr': 'Lary', 'pgto_ot': '2026-03-06', 'pgto_mrr': '2026-04-01'},
    'Hair Group Medical': {'sdr': 'Luiz', 'pgto_ot': None, 'pgto_mrr': '2026-05-05'},
}

def safe_str(val):
    if pd.isna(val): return None
    s = str(val).strip()
    return s if s and s != 'nan' else None

def parse_date(val):
    if pd.isna(val): return None
    if isinstance(val, datetime): return val.strftime('%Y-%m-%d')
    return None

def parse_num(val):
    if pd.isna(val): return 0
    try: return float(val)
    except: return 0

def parse_int_bant(val):
    if pd.isna(val): return None
    try:
        v = int(float(val))
        return v if 1 <= v <= 4 else None
    except: return None

xls = pd.ExcelFile(r'C:\Users\gabri\Downloads\Dash de Aquisição _ Ruston & Co. (2).xlsx')
df = pd.read_excel(xls, sheet_name='Negociações BR', header=0)

imported = 0
errors = 0

for _, row in df.iterrows():
    empresa = safe_str(row.get('EMPRESA'))
    if not empresa: continue

    status = status_map.get(safe_str(row.get('STATUS', '')), 'negociacao')
    closer_name = safe_str(row.get('CLOSER', ''))
    closer_id = members.get(closer_name)
    origem = origem_map.get(safe_str(row.get('ORIGEM', '')))
    temp = temp_map.get(safe_str(row.get('TEMPERATURA', '')))

    # Check for March override
    override = march_overrides.get(empresa)
    data_fec = parse_date(row.get('DATA DO FEC.'))
    is_march_ganho = (status == 'contrato_assinado' and data_fec and data_fec.startswith('2026-03'))

    # SDR
    sdr_id = None
    if override and is_march_ganho:
        sdr_name = override.get('sdr')
        sdr_id = members.get(sdr_name) if sdr_name else None
    # Default SDR from Goldens special case
    if empresa == 'Goldens do Gaulês':
        sdr_id = members.get('Lary')

    # Payment dates
    data_pgto_escopo = None
    data_pgto_recorrente = None
    if override and is_march_ganho:
        data_pgto_escopo = override.get('pgto_ot')
        data_pgto_recorrente = override.get('pgto_mrr')

    try:
        cur.execute(
            """INSERT INTO deals (empresa, kommo_id, kommo_link, closer_id, sdr_id,
                data_call, data_fechamento, data_primeiro_pagamento,
                valor_mrr, valor_ot, valor_recorrente, valor_escopo,
                data_pgto_escopo, data_pgto_recorrente,
                status, produto, origem, temperatura, bant,
                motivo_perda, curva_dias, data_retorno)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (empresa,
             safe_str(row.get('ID KOMMO')),
             safe_str(row.get('LINK KOMMO')),
             closer_id, sdr_id,
             parse_date(row.get('DATA DA CALL')),
             data_fec,
             parse_date(row.get('DATA 1º PGTO')),
             parse_num(row.get('VALOR MRR')),
             parse_num(row.get('VALOR OT')),
             parse_num(row.get('VALOR MRR')),  # valor_recorrente = same as MRR
             parse_num(row.get('VALOR OT')),   # valor_escopo = same as OT
             data_pgto_escopo,
             data_pgto_recorrente,
             status,
             safe_str(row.get('PRODUTO')),
             origem, temp,
             parse_int_bant(row.get('BANT')),
             safe_str(row.get('MOTIVOS DE PERDA')),
             int(float(row.get('CURVA DIAS'))) if pd.notna(row.get('CURVA DIAS')) else None,
             parse_date(row.get('DATA RETORNO'))))
        imported += 1
    except Exception as e:
        errors += 1
        if errors <= 5: print(f'Deal err [{empresa}]: {e}')

print(f'\nDeals imported: {imported} | Errors: {errors}')

cur.execute('SELECT status, count(*) FROM deals GROUP BY status ORDER BY count(*) DESC')
for r in cur.fetchall():
    print(f'  {r[0]}: {r[1]}')

# Verify March ganhos
cur.execute("""SELECT empresa, closer_id, sdr_id, data_pgto_escopo, data_pgto_recorrente
FROM deals WHERE status = 'contrato_assinado' AND data_fechamento >= '2026-03-01' AND data_fechamento <= '2026-03-31'
ORDER BY empresa""")
print(f'\nMarch ganhos verification:')
for r in cur.fetchall():
    print(f'  {r[0]:30s} | closer={str(r[1])[:8] if r[1] else "NULL":8s} | sdr={str(r[2])[:8] if r[2] else "NULL":8s} | pgto_ot={r[3]} | pgto_mrr={r[4]}')

cur.close()
conn.close()
