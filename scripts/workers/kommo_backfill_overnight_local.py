#!/usr/bin/env python3
# kommo_backfill_overnight_local.py — ORQUESTRADOR AUTONOMO do backfill noturno (LOCAL).
# Roda o worker de backfill em loop e, quando a sessao morre, RELOGA sozinho e retoma —
# a noite toda, sem intervencao. Para quando a fila esvazia, empaca (stall), ou bate num
# limite de seguranca. Login que falha => PARA na hora (nunca insiste — insistir queima a conta).
#
# NAO REESCREVE NADA. Chama, como subprocesso, os scripts que ja existem e funcionam:
#   - kommo_msg_worker_local.py  (extrator v9 congelado + guard consertado)  -> extrai/grava/marca
#   - session_probe_local.py     (fluxo de login que o Gabriel confirmou rodar LIMPO)  -> reloga
# Os codigos de saida ja dizem tudo: worker sai 2 = sessao morreu (relogar); 0 = fila drenada/vazia;
# 1 = erro de config. login sai 0 = ok (storage_state.json renovado); !=0 = falhou (captcha/bloqueio).
#
# CREDENCIAIS (seguranca): o login le KOMMO_WEB_USER / KOMMO_WEB_PASS do AMBIENTE (mesmo
# mecanismo do session_probe_local.py). O worker le SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
# Este orquestrador NUNCA le, imprime ou grava a senha — so herda o ambiente e repassa aos
# filhos. Nada de credencial no codigo, no git, nem no log. SMTP_* sao REMOVIDOS do worker filho
# (senao ele mandaria um email a cada morte de sessao — spam); o registro fica no log daqui.
#
# PROTECOES ANTI-BLOQUEIO (login automatizado repetido pode acordar a deteccao do Kommo):
#   --min-relogin-min     intervalo minimo entre logins (espaca; nao martela).            [4]
#   --max-relogins        teto de relogins na noite; passou => PARA e avisa.              [60]
#   --min-leads-session   morte "rapida" = worker morreu com MENOS leads que isso.        [3]
#   --max-fast-deaths     N mortes rapidas SEGUIDAS => PARA (sinal de bloqueio).          [2]
#   --block-pause-sec     respiro entre blocos (antes de cada rodada do worker).          [30]
#   --max-hours           teto de horas de execucao (backstop de fim de noite).           [10]
#   --max-cycles          teto de rodadas do worker (backstop).                           [200]
# Se um login FALHAR (captcha/bloqueio/credencial) => PARA imediatamente, loga o motivo, NAO tenta de novo.
#
# USO (PowerShell, MESMA pasta do storage_state.json e dos 3 scripts):
#   pip install playwright requests ; python -m playwright install chromium
#   set KOMMO_WEB_USER=robozinho@robozinho.com
#   set KOMMO_WEB_PASS=...                 (NUNCA commitar)
#   set SUPABASE_URL=https://iaompeiokjxbffwehhrx.supabase.co
#   set SUPABASE_SERVICE_ROLE_KEY=...      (service_role; NUNCA commitar)
#   python kommo_backfill_overnight_local.py
# De manha: leia o overnight_*.log (ou o console). O resumo final diz por que parou.
import os, sys, re, time, argparse, datetime, pathlib, subprocess
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass

HERE = pathlib.Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# POLITICA (funcoes puras — testaveis offline, sem subprocesso/rede)
# ---------------------------------------------------------------------------
def parse_worker_output(text):
    """Extrai do stdout do worker: fila inicial, leads processados, deferidos e 'nada a fazer'."""
    def num(pat, default=None):
        m = re.search(pat, text)
        return int(m.group(1)) if m else default
    return {
        "fila":     num(r"fila:\s*(\d+)\s*leads"),
        "done":     num(r"leads processados:\s*(\d+)", 0),
        "deferred": num(r"deferidos \([^)]*\):\s*(\d+)", 0),
        "nada":     ("nada a fazer" in text),
    }

def classify_worker_run(code, p):
    """Classifica o resultado de UMA rodada do worker.
       'complete'  : fila vazia / drenada sem sobrar nada  -> backfill acabou.
       'progress'  : drenou (saiu 0) mas sobraram deferidos e HOUVE progresso -> re-roda.
       'stall'     : drenou (saiu 0), sobraram deferidos e NAO houve progresso -> empacou.
       'session_death' : saiu 2 -> sessao morreu -> relogar.
       'config_error'  : saiu 1/outro -> erro de config/inesperado -> parar."""
    if p["nada"] or p["fila"] == 0:
        return "complete"
    if code == 0:
        if p["deferred"] == 0:
            return "complete"
        return "progress" if p["done"] > 0 else "stall"
    if code == 2:
        return "session_death"
    return "config_error"

def relogin_gate(relogins, fast_deaths, run_done, min_since_login, args):
    """Anti-bloqueio: decide se PODE relogar apos uma morte de sessao. Puro.
       Retorna (action, wait_sec, reason, new_fast_deaths).
       action: 'relogin' (talvez com espera) ou 'stop'."""
    fast = run_done < args.min_leads_session          # morreu cedo demais = anormal
    new_fast = (fast_deaths + 1) if fast else 0
    if fast and new_fast >= args.max_fast_deaths:
        return ("stop", 0,
                f"{new_fast} mortes de sessao SEGUIDAS com <{args.min_leads_session} leads "
                f"(local costuma aguentar ~25). Cheira a bloqueio do Kommo — nao vou martelar login.",
                new_fast)
    if relogins >= args.max_relogins:
        return ("stop", 0, f"atingi o teto de relogins da noite (--max-relogins={args.max_relogins}). "
                           f"Pode ser bloqueio; parando por seguranca.", new_fast)
    wait = 0
    if min_since_login is not None and min_since_login < args.min_relogin_min:
        wait = int((args.min_relogin_min - min_since_login) * 60)
    return ("relogin", wait, "ok", new_fast)

# ---------------------------------------------------------------------------
# EXECUCAO (subprocessos) — glue fino em volta da politica acima
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="Backfill noturno autonomo do Kommo (loop + relogin).")
    ap.add_argument("--worker", default=str(HERE / "kommo_msg_worker_local.py"),
                    help="caminho do worker de backfill")
    ap.add_argument("--login",  default=str(HERE / "session_probe_local.py"),
                    help="caminho do script de login (fluxo que roda limpo)")
    ap.add_argument("--min-relogin-min", type=float, default=4.0)
    ap.add_argument("--max-relogins",    type=int,   default=60)
    ap.add_argument("--min-leads-session", type=int, default=3)
    ap.add_argument("--max-fast-deaths", type=int,   default=2)
    ap.add_argument("--block-pause-sec", type=float, default=30.0)
    ap.add_argument("--max-hours",       type=float, default=10.0)
    ap.add_argument("--max-cycles",      type=int,   default=200)
    ap.add_argument("--worker-args", default="--mode backfill",
                    help="args repassados ao worker (default: '--mode backfill')")
    args = ap.parse_args()

    # --- valida presenca das credenciais SEM imprimir valores ---
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
                           "KOMMO_WEB_USER", "KOMMO_WEB_PASS") if not os.environ.get(k)]
    if missing:
        sys.exit("Faltam variaveis de ambiente (nunca coloque no codigo/git): " + ", ".join(missing))
    worker = pathlib.Path(args.worker); login = pathlib.Path(args.login)
    for name, p in (("worker", worker), ("login", login)):
        if not p.exists():
            sys.exit(f"{name} nao encontrado: {p}  (use --{name} pra apontar o caminho)")

    # --- log da noite (console + arquivo) ---
    started = datetime.datetime.now()
    logpath = pathlib.Path(f"overnight_{started.strftime('%Y%m%d_%H%M%S')}.log")
    logf = open(logpath, "w", encoding="utf-8")

    def emit(tag, line):
        stamp = datetime.datetime.now().strftime("%H:%M:%S")
        msg = f"[{tag} {stamp}] {line}"
        print(msg, flush=True); logf.write(msg + "\n"); logf.flush()

    def olog(line): emit("ORQ", line)

    def run_and_stream(argv, env, tag):
        """Roda um filho, transmite cada linha pro console+log, devolve (returncode, texto)."""
        p = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, bufsize=1)
        buf = []
        for line in p.stdout:
            line = line.rstrip("\n"); buf.append(line); emit(tag, line)
        p.wait()
        return p.returncode, "\n".join(buf)

    # ambiente do worker: herda tudo, MENOS SMTP (senao manda email a cada morte -> spam)
    worker_env = {k: v for k, v in os.environ.items()
                  if not k.startswith("SMTP_") and k != "ALERT_EMAIL_TO"}
    login_env = dict(os.environ)  # login precisa de KOMMO_WEB_USER/PASS

    def do_login(reason):
        olog(f"RELOGIN ({reason}) — chamando o fluxo de login (headed)…")
        code, _ = run_and_stream([sys.executable, str(login)], login_env, "LOGIN")
        ok = (code == 0) and pathlib.Path("storage_state.json").exists()
        olog("  login OK — storage_state.json renovado." if ok
             else f"  login FALHOU (exit {code}).")
        return ok

    # ------- estado da noite -------
    relogins = 0; fast_deaths = 0; stall_streak = 0; cycle = 0
    last_login_ts = None; done_total = 0; last_fila = None; stop_reason = None
    deadline = started + datetime.timedelta(hours=args.max_hours)

    olog(f"inicio {started:%Y-%m-%d %H:%M:%S} | worker={worker.name} login={login.name}")
    olog(f"limites: min_relogin={args.min_relogin_min}min max_relogins={args.max_relogins} "
         f"min_leads_session={args.min_leads_session} max_fast_deaths={args.max_fast_deaths} "
         f"pausa_bloco={args.block_pause_sec}s max_horas={args.max_hours} max_ciclos={args.max_cycles}")

    # login inicial so se nao houver sessao ainda (se houver, o loop trata a expiracao via saida 2)
    if not pathlib.Path("storage_state.json").exists():
        olog("sem storage_state.json — login inicial (nao conta como relogin).")
        if not do_login("login inicial"):
            stop_reason = "login inicial falhou (captcha/bloqueio/credencial). NAO insisto."
            olog("PARO: " + stop_reason); logf.close(); sys.exit(2)
        last_login_ts = time.time()

    # ------- loop principal -------
    while True:
        if cycle >= args.max_cycles:
            stop_reason = f"teto de ciclos (--max-cycles={args.max_cycles})"; break
        if datetime.datetime.now() >= deadline:
            stop_reason = f"teto de horas (--max-hours={args.max_hours})"; break
        cycle += 1

        if args.block_pause_sec > 0:
            time.sleep(args.block_pause_sec)   # respiro entre blocos (nunca lead-atras-de-lead sem pausa)

        olog(f"--- ciclo {cycle} --- rodando o worker (relogins ate agora: {relogins})")
        argv = [sys.executable, str(worker)] + args.worker_args.split()
        code, out = run_and_stream(argv, worker_env, "WORKER")
        p = parse_worker_output(out)
        if p["fila"] is not None: last_fila = p["fila"]
        done_total += p["done"]
        olog(f"  worker saiu {code} | fila={p['fila']} processados={p['done']} "
             f"deferidos={p['deferred']} nada={p['nada']}")

        kind = classify_worker_run(code, p)

        if kind == "complete":
            stop_reason = "FILA VAZIA — backfill completo 🎉"; break

        if kind == "progress":
            stall_streak = 0
            olog(f"  progresso ({p['done']} leads) mas sobraram {p['deferred']} deferidos — re-rodo.")
            continue

        if kind == "stall":
            stall_streak += 1
            olog(f"  rodada sem progresso (0 processados, {p['deferred']} deferidos). "
                 f"stall_streak={stall_streak}/2")
            if stall_streak >= 2:
                stop_reason = (f"EMPACOU — {p['deferred']} leads deferidos nao avancam "
                               f"(chat WA/desconhecido com 0 balao ou skeleton persistente). "
                               f"Ficam pendentes pra investigar; o resto do backfill esta feito.")
                break
            continue

        if kind == "config_error":
            stop_reason = f"worker saiu com codigo {code} (erro de config/inesperado). Veja o log acima."
            break

        # kind == 'session_death' -> anti-bloqueio + relogin
        since_min = (time.time() - last_login_ts) / 60 if last_login_ts else None
        action, wait_sec, reason, fast_deaths = relogin_gate(
            relogins, fast_deaths, p["done"], since_min, args)
        if action == "stop":
            stop_reason = reason; break
        if fast_deaths:
            olog(f"  ATENCAO: morte rapida ({p['done']} leads < {args.min_leads_session}). "
                 f"mortes rapidas seguidas: {fast_deaths}/{args.max_fast_deaths}")
        if wait_sec > 0:
            olog(f"  intervalo minimo entre logins: aguardando {wait_sec//60}min{wait_sec%60}s…")
            time.sleep(wait_sec)
        if not do_login(f"sessao morreu no ciclo {cycle}"):
            stop_reason = ("login FALHOU no meio da noite (captcha/bloqueio/credencial). "
                           "PARO na hora e NAO tento de novo — insistir num login bloqueado "
                           "e o que queima a conta. Backfill retoma sozinho quando voce relogar de manha.")
            break
        relogins += 1; last_login_ts = time.time()

    # ------- resumo final -------
    dur = datetime.datetime.now() - started
    emit("FIM", "=" * 60)
    emit("FIM", f"motivo da parada: {stop_reason}")
    emit("FIM", f"duracao: {str(dur).split('.')[0]} | ciclos: {cycle} | relogins: {relogins} "
                f"| mortes rapidas: {fast_deaths}")
    emit("FIM", f"leads processados no total (aprox): {done_total} | fila da ultima rodada: {last_fila}")
    emit("FIM", f"log salvo em: {logpath.resolve()}")
    logf.close()

if __name__ == "__main__":
    main()
