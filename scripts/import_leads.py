import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import pandas as pd
import psycopg2
from datetime import datetime

conn = psycopg2.connect(host='db.iaompeiokjxbffwehhrx.supabase.co', port=5432, dbname='postgres', user='postgres', password='4562rd77fms0vrIr', sslmode='require')
conn.autocommit = True
cur = conn.cursor()

cur.execute('SELECT id, name, role FROM team_members')
members = {}
for r in cur.fetchall():
    members[r[1]] = str(r[0])
    members[r[1].split(' ')[0]] = str(r[0])
members['Jenni'] = members.get('Jenniffer', members.get('Jenniffer Canalli', ''))
members['Laryssa'] = members.get('Lary', '')
members['Gabrielli'] = members.get('Gabrielli Estevão Nene', '')
members['Ricardo'] = members.get('Ricardo Matheus Costa', '')
members['Adriano'] = members.get('Adriano Ramos Burger', '')

xls = pd.ExcelFile(r'C:\Users\gabri\Downloads\Dash de Aquisição _ Ruston & Co. (2).xlsx')

status_map = {
    'Reunião Marcada': 'reuniao_marcada', 'Reunião Acontecida': 'reuniao_realizada',
    'Em follow': 'em_follow', 'Sem contato': 'sem_contato', 'Perdido': 'perdido',
    'Follow Longo': 'em_follow', 'Estorno': 'estorno', 'NoShow': 'noshow',
    'Sem Contato': 'sem_contato', 'Follow longo': 'em_follow',
}

def safe_str(val):
    if pd.isna(val): return None
    s = str(val).strip()
    return s if s and s != 'nan' else None

def parse_date(val):
    if pd.isna(val): return None
    if isinstance(val, datetime): return val.strftime('%Y-%m-%d')
    s = str(val).strip()
    if '/' in s and len(s) <= 5:
        parts = s.split('/')
        if len(parts) == 2:
            return f'2026-{parts[1].zfill(2)}-{parts[0].zfill(2)}'
    return None

def parse_mes_box(val):
    if pd.isna(val): return None
    s = str(val).strip().lower()
    m = {'janeiro': '01', 'fevereiro': '02', 'março': '03', 'marco': '03', 'abril': '04'}
    for nome, num in m.items():
        if nome in s: return f'2026-{num}-01'
    return None

total = 0
errors = 0

# BLACKBOX
df = pd.read_excel(xls, sheet_name='BlackBox', header=0)
cnt = 0
for _, r in df.iterrows():
    empresa = safe_str(r.get('EMPRESAS'))
    if not empresa: continue
    sdr = members.get(safe_str(r.get('SDR')))
    status = status_map.get(safe_str(r.get('STATUS', '')), 'sem_contato')
    data_cad = parse_date(r.get('DATA CADASTRO'))
    if not data_cad:
        data_cad = parse_mes_box(r.get('MÊS BOX'))
    try:
        cur.execute(
            "INSERT INTO leads (empresa,nome_contato,telefone,canal,fonte,produto,sdr_id,kommo_id,kommo_link,status,faturamento,data_cadastro,mes_referencia) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (empresa, safe_str(r.get('NOME')), safe_str(r.get('TELEFONE')), 'blackbox',
             safe_str(r.get('CANAL')), safe_str(r.get('PRODUTO')), sdr,
             safe_str(r.get('ID KOMMO')), safe_str(r.get('Link Kommo')),
             status, safe_str(r.get('FATURAMENTO')), data_cad, safe_str(r.get('Mês'))))
        cnt += 1
    except Exception as e:
        errors += 1
        if errors <= 3: print(f'BB err: {e}')
total += cnt
print(f'BlackBox: {cnt}')

# LEADBROKER
df = pd.read_excel(xls, sheet_name='LeadBroker', header=0)
cnt = 0
for _, r in df.iterrows():
    empresa = safe_str(r.get('EMPRESAS'))
    if not empresa: continue
    sdr = members.get(safe_str(r.get('SDR')))
    status = status_map.get(safe_str(r.get('STATUS', '')), 'sem_contato')
    kommo_link = safe_str(r.get('Link Kommo')) if 'Link Kommo' in r.index else None
    try:
        cur.execute(
            "INSERT INTO leads (empresa,nome_contato,telefone,cnpj,canal,fonte,produto,sdr_id,kommo_id,kommo_link,status,faturamento,data_cadastro,valor_lead,mes_referencia) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (empresa, safe_str(r.get('NOME')), safe_str(r.get('TELEFONE')),
             safe_str(r.get('CNPJ')), 'leadbroker', safe_str(r.get('CANAL')),
             safe_str(r.get('PRODUTO')), sdr, safe_str(r.get('ID KOMMO')), kommo_link,
             status, safe_str(r.get('FATURAMENTO')),
             parse_date(r.get('DATA DA COMPRA')),
             float(r.get('VALOR', 0)) if pd.notna(r.get('VALOR')) else None,
             safe_str(r.get('Mês'))))
        cnt += 1
    except Exception as e:
        errors += 1
        if errors <= 6: print(f'LB err: {e}')
total += cnt
print(f'LeadBroker: {cnt}')

# OUTBOUND
df = pd.read_excel(xls, sheet_name='Outbound', header=0)
cnt = 0
for _, r in df.iterrows():
    empresa = safe_str(r.get('EMPRESA'))
    if not empresa: continue
    sdr = members.get(safe_str(r.get('BDR')))
    status = status_map.get(safe_str(r.get('STATUS', '')), 'sem_contato')
    try:
        cur.execute(
            "INSERT INTO leads (empresa,nome_contato,telefone,canal,sdr_id,kommo_id,kommo_link,status,data_cadastro,mes_referencia) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (empresa, safe_str(r.get('NOME')), safe_str(r.get('TELEFONE')),
             'outbound', sdr, safe_str(r.get('ID KOMMO')),
             safe_str(r.get('Link Kommo')), status,
             parse_date(r.get('DATA DO AGENDAMENTO')), safe_str(r.get('Mês'))))
        cnt += 1
    except Exception as e:
        errors += 1
total += cnt
print(f'Outbound: {cnt}')

# RECOMENDACAO
try:
    df = pd.read_excel(xls, sheet_name='Recomendação', header=0)
    cnt = 0
    cols = list(df.columns)
    for _, r in df.iterrows():
        empresa = safe_str(r.get(cols[0]))
        if not empresa: continue
        sdr_name = safe_str(r.get('SDR')) if 'SDR' in cols else safe_str(r.get(cols[1]))
        sdr = members.get(sdr_name) if sdr_name else None
        try:
            cur.execute(
                "INSERT INTO leads (empresa,nome_contato,telefone,canal,sdr_id,kommo_id,status) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (empresa, safe_str(r.get(cols[3]) if len(cols) > 3 else None),
                 safe_str(r.get(cols[4]) if len(cols) > 4 else None),
                 'recomendacao', sdr,
                 safe_str(r.get(cols[2]) if len(cols) > 2 else None), 'sem_contato'))
            cnt += 1
        except: errors += 1
    total += cnt
    print(f'Recomendação: {cnt}')
except Exception as e:
    print(f'Recomendação: skip ({e})')

# INDICACAO
try:
    df = pd.read_excel(xls, sheet_name='Indicação', header=0)
    cnt = 0
    cols = list(df.columns)
    for _, r in df.iterrows():
        empresa = safe_str(r.get(cols[0]))
        if not empresa: continue
        sdr_name = safe_str(r.get('SDR')) if 'SDR' in cols else safe_str(r.get(cols[1]))
        sdr = members.get(sdr_name) if sdr_name else None
        try:
            cur.execute(
                "INSERT INTO leads (empresa,nome_contato,telefone,canal,sdr_id,kommo_id,status) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (empresa, safe_str(r.get(cols[3]) if len(cols) > 3 else None),
                 safe_str(r.get(cols[4]) if len(cols) > 4 else None),
                 'indicacao', sdr,
                 safe_str(r.get(cols[2]) if len(cols) > 2 else None), 'sem_contato'))
            cnt += 1
        except: errors += 1
    total += cnt
    print(f'Indicação: {cnt}')
except Exception as e:
    print(f'Indicação: skip ({e})')

print(f'\nTOTAL LEADS: {total} | Errors: {errors}')
cur.execute('SELECT canal, count(*) FROM leads GROUP BY canal ORDER BY count(*) DESC')
for r in cur.fetchall():
    print(f'  {r[0]}: {r[1]}')

cur.close()
conn.close()
