import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import psycopg2

conn = psycopg2.connect(
    host='db.iaompeiokjxbffwehhrx.supabase.co', port=5432,
    dbname='postgres', user='postgres', password='4562rd77fms0vrIr',
    sslmode='require'
)
cur = conn.cursor()

# List all triggers on leads table
cur.execute("""
    SELECT trigger_name, event_manipulation, action_timing, action_statement
    FROM information_schema.triggers
    WHERE event_object_table = 'leads'
    ORDER BY trigger_name
""")
print('=== TRIGGERS on leads ===')
for r in cur.fetchall():
    print(f'  {r[0]} | {r[2]} {r[1]}')
    print(f'    -> {r[3][:200]}')
    print()

# Also check if there's a trigger function that calls kommo/pg_net
cur.execute("""
    SELECT proname, prosrc
    FROM pg_proc
    WHERE prosrc ILIKE '%kommo%' OR prosrc ILIKE '%net.http%' OR proname ILIKE '%kommo%'
    ORDER BY proname
""")
print('=== FUNCTIONS referencing kommo/net.http ===')
for r in cur.fetchall():
    print(f'  Function: {r[0]}')
    print(f'    Source: {r[1][:500]}')
    print()

cur.close()
conn.close()
