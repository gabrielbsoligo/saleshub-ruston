import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import psycopg2

conn = psycopg2.connect(
    host='db.iaompeiokjxbffwehhrx.supabase.co', port=5432,
    dbname='postgres', user='postgres', password='4562rd77fms0vrIr',
    sslmode='require'
)
cur = conn.cursor()

cur.execute("SELECT prosrc FROM pg_proc WHERE proname = 'sync_lead_to_kommo'")
(src,) = cur.fetchone()
print(src)

print('\n\n=== process_kommo_responses ===')
cur.execute("SELECT prosrc FROM pg_proc WHERE proname = 'process_kommo_responses'")
(src2,) = cur.fetchone()
print(src2)

cur.close()
conn.close()
