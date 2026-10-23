/**
 * Ruston Pré-vendas — widget único do Kommo (Web SDK): NOTIFY + PRÓXIMO (+ click-to-call na fatia 3).
 *
 * - NOTIFY: pop-up persistente das tarefas que vencem em breve (som + notificação do navegador).
 * - PRÓXIMO: abre a próxima tarefa do SDR pela ordem de MOMENTO → ORIGEM → VENCIMENTO.
 *   A classificação (momento, ação, origem) vem do servidor (edge prevendas-classificar), autenticada
 *   pelo token descartável do Kommo ($authorizedAjax). Sem servidor, cai num modo degradado por vencimento.
 *   Regras: kommo-widget/ruston-prevendas/PROPOSTA.md §2.3–2.5.
 *
 * Leitura de tarefas: mesma origem, sessão do próprio SDR (sem token no front), PAGINADA.
 * Namespace: "rpv-" / "rpv_".
 *
 * O bloco "Fila" é puro (sem DOM): exportado em module.exports para os testes em Node.
 */
(function () {
  // ======================================================================
  // Fila — regras puras de ordenação (testadas em tests/fila.test.js)
  // ======================================================================
  var Fila = (function () {
    var NIVEL = { anti_noshow: 1, speed_to_lead: 2, conexao: 3, follow_up: 4, recuperar: 5, pre_reuniao: 6, sem_classificacao: 9 };
    var GRUPOS_PADRAO = ['G1', 'G2', 'G3', 'G4', 'G5', 'G9'];
    var COM_ORIGEM = { 4: 1, 5: 1, 7: 1 };              // níveis em que a origem desempata
    var ROTULO = {
      anti_noshow: 'Anti no-show', speed_to_lead: 'Speed to lead', conexao: 'Conexão', follow_up: 'Follow-up',
      recuperar: 'Recuperar no-show', pre_reuniao: 'Pré-reunião', prospeccao: 'Prospecção', sem_classificacao: 'Outras'
    };
    var ROTULO_GRUPO = { G1: 'Indicação', G2: 'Inbound', G3: 'Base própria', G4: 'Leadbroker', G5: 'Outbound', G9: 'Sem origem' };

    // prospecção: quente (G1–G4) = 7, sem origem (G9) = 7.5 (neutro, sem janela), outbound (G5) = 8
    function nivel(item) {
      if (item.momento === 'prospeccao') return item.grupo === 'G5' ? 8 : (item.grupo === 'G9' ? 7.5 : 7);
      var n = NIVEL[item.momento];
      return n == null ? 9 : n;
    }

    // "HH:MM" -> minutos do dia
    function minutos(hhmm) {
      var m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return 16 * 60;
      return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
    }

    /**
     * itens: [{id, due, momento, grupo, urgente}]  (due = unix s; 0 = sem prazo)
     * cfg:   {antecedencia_min, outbound_apos:"HH:MM", grupos:[...]}
     * agora: unix s · minutoDoDia: minutos locais (0..1439)
     * retorna {fila:[...ordenada], futura: item|null}
     */
    function ordenar(itens, cfg, agora, minutoDoDia) {
      var limite = agora + (cfg.antecedencia_min == null ? 10 : cfg.antecedencia_min) * 60;
      var grupos = cfg.grupos && cfg.grupos.length ? cfg.grupos : GRUPOS_PADRAO;
      var gi = function (g) { var i = grupos.indexOf(g); return i === -1 ? grupos.length : i; };

      var elegiveis = [], futuras = [];
      itens.forEach(function (it) {
        var n = nivel(it);
        var x = { item: it, nivel: n };
        if (it.urgente || !it.due || it.due <= limite) elegiveis.push(x); else futuras.push(x);
      });

      // janela do outbound (só nível 8): depois do corte, ou se não houver mais nada elegível
      var depoisDoCorte = minutoDoDia >= minutos(cfg.outbound_apos);
      var temOutra = elegiveis.some(function (x) { return x.nivel !== 8; });
      var fila = elegiveis.filter(function (x) {
        if (x.nivel !== 8) return true;
        if (depoisDoCorte || !temOutra) return true;
        futuras.push(x);   // segura o outbound para depois
        return false;
      });

      fila.sort(function (a, b) {
        if (a.nivel !== b.nivel) return a.nivel - b.nivel;
        if (COM_ORIGEM[Math.floor(a.nivel)]) {
          var g = gi(a.item.grupo) - gi(b.item.grupo);
          if (g) return g;
        }
        var da = a.item.due || 0, db = b.item.due || 0;
        if (da !== db) return da - db;
        return a.item.id - b.item.id;
      });
      futuras.sort(function (a, b) { return ((a.item.due || 0) - (b.item.due || 0)) || (a.item.id - b.item.id); });

      return {
        fila: fila.map(function (x) { return x.item; }),
        futura: futuras.length ? futuras[0].item : null
      };
    }

    /**
     * Escolhe quais tarefas mandar para classificação no servidor (máx. `max`):
     *  A) recentes/urgentes: criadas nos últimos 30 min ou vencendo entre agora-24h e agora+antecedência;
     *  B) depois, as mais antigas vencidas.
     * Assim um backlog antigo não empurra a anti no-show de agora para fora. `parcial` = cortou alguma.
     */
    function candidatas(tarefas, agora, antecedenciaMin, max) {
      var lim = agora + antecedenciaMin * 60, a = [], b = [];
      tarefas.forEach(function (t) {
        var due = t.complete_till || 0;
        var recente = (t.created_at && t.created_at >= agora - 30 * 60) || (due >= agora - 24 * 3600 && due <= lim);
        if (recente) a.push(t);
        else if (due && due <= lim) b.push(t);
      });
      var porDue = function (x, y) { return (x.complete_till || 0) - (y.complete_till || 0); };
      a.sort(porDue); b.sort(porDue);
      var todas = a.concat(b);
      return { lista: todas.slice(0, max), parcial: todas.length > max };
    }

    // modo degradado (sem servidor): só o que dá para saber no navegador
    function classificarLocal(t) {
      var txt = String(t.text || '');
      if (/^CADENCIA: lead respondeu/i.test(txt)) return { momento: 'conexao', grupo: 'G9', urgente: true, acao: 'ligar', fonte: 'local' };
      return { momento: 'sem_classificacao', grupo: 'G9', urgente: false, acao: 'outro', fonte: 'local' };
    }

    return { ordenar: ordenar, nivel: nivel, candidatas: candidatas, classificarLocal: classificarLocal, minutos: minutos, ROTULO: ROTULO, ROTULO_GRUPO: ROTULO_GRUPO };
  })();

  if (typeof module === 'object' && module && module.exports) { module.exports = Fila; return; }

  // ======================================================================
  // Widget
  // ======================================================================
  define(['jquery'], function ($) {
    var CustomWidget = function () {
      var self = this;
      var NS = 'rpv';
      var DEFAULTS = {
        endpoint: '', usuarios: '', position: 'bottom-right', offset: 96, poll_seconds: 45,
        antecedencia_min: 10, outbound_apos: '16:00', grupos: 'G1,G2,G3,G4,G5,G9',
        sound: 'Y', lookahead_min: 15, atalho: 'Y'
      };
      var POS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
      var MAX_PAGINAS = 10, MAX_CLASSIF = 500, CACHE_MS = 5 * 60 * 1000;

      var state = {
        booted: false, timer: null, uid: null, sub: 'acc', base: '', audio: null,
        tarefas: [], porId: {}, classe: {}, classeEm: {},  // classificação em cache por tarefa
        fila: [], futura: null, parcial: false, servidor: 'aguardando', loading: false,
        open: false, atual: null, names: {},
        notif: [], seen: {}
      };

      // ---------------- helpers ----------------
      function cfg() {
        var s = {};
        try { s = self.get_settings() || {}; } catch (e) { s = {}; }
        var pos = String(s.position || DEFAULTS.position).trim().toLowerCase();
        if (POS.indexOf(pos) === -1) pos = DEFAULTS.position;
        var int = function (v, d, min, max) { var n = parseInt(v, 10); if (isNaN(n) || n < min) n = d; return max ? Math.min(n, max) : n; };
        return {
          endpoint: String(s.endpoint || DEFAULTS.endpoint).trim(),
          usuarios: String(s.usuarios || DEFAULTS.usuarios).split(',').map(function (x) { return x.trim(); }).filter(Boolean),
          position: pos,
          offset: int(s.offset, DEFAULTS.offset, 0, 400),
          poll: int(s.poll_seconds, DEFAULTS.poll_seconds, 15),
          antecedencia_min: int(s.antecedencia_min, DEFAULTS.antecedencia_min, 0, 240),
          outbound_apos: /^\d{1,2}:\d{2}$/.test(String(s.outbound_apos || '').trim()) ? String(s.outbound_apos).trim() : DEFAULTS.outbound_apos,
          grupos: String(s.grupos || DEFAULTS.grupos).split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean),
          sound: String(s.sound || DEFAULTS.sound).toUpperCase() !== 'N',
          lookahead: int(s.lookahead_min, DEFAULTS.lookahead_min, 0, 240),
          atalho: String(s.atalho || DEFAULTS.atalho).toUpperCase() !== 'N'
        };
      }
      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      function agoraS() { return Math.floor(Date.now() / 1000); }
      function minutoDoDia() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
      function fmtQuando(unix, now) {
        if (!unix) return 'sem prazo';
        var diff = unix - now, d = new Date(unix * 1000);
        if (diff < 0) {
          var m = Math.floor(-diff / 60);
          return m < 60 ? 'atrasada ' + m + 'min' : (m < 1440 ? 'atrasada ' + Math.floor(m / 60) + 'h' : 'atrasada ' + Math.floor(m / 1440) + 'd');
        }
        var hoje = new Date(now * 1000).toDateString() === d.toDateString();
        return (hoje ? '' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ') + pad(d.getHours()) + ':' + pad(d.getMinutes());
      }
      function key(n) { return NS + '_' + n + '_' + state.sub + '_' + state.uid; }
      function lsGet(n, d) { try { return JSON.parse(localStorage.getItem(key(n)) || '') || d; } catch (e) { return d; } }
      function lsSet(n, v) { try { localStorage.setItem(key(n), JSON.stringify(v)); } catch (e) {} }

      function ativoParaEsteUsuario() {
        var u = cfg().usuarios;
        return !u.length || u.indexOf(String(state.uid)) !== -1;   // vazio = todos
      }

      // ---------------- navegação ----------------
      function seg(etype) { return { leads: 'leads', contacts: 'contacts', companies: 'companies', customers: 'customers' }[etype] || 'leads'; }
      function abrir(etype, eid) {
        var path = '/' + seg(etype) + '/detail/' + eid;
        try { if (window.AMOCRM && AMOCRM.Router && AMOCRM.Router.navigate) { AMOCRM.Router.navigate(path, { trigger: true }); return; } } catch (e) {}
        try { if (window.AMOCRM && AMOCRM.redirect) { AMOCRM.redirect(path); return; } } catch (e) {}
        window.location.href = location.origin + path;
      }
      function entidadeAtual() {
        var m = String(location.pathname).match(/\/(leads|contacts|companies|customers)\/detail\/(\d+)/);
        return m ? { etype: m[1], eid: parseInt(m[2], 10) } : null;
      }

      // ---------------- leitura de tarefas (paginada) ----------------
      function lerTarefas(cb) {
        var todas = [], pagina = 1, parcial = false;
        function prox() {
          var url = '/api/v4/tasks?filter[responsible_user_id]=' + encodeURIComponent(state.uid) +
                    '&filter[is_completed]=0&order[complete_till]=asc&limit=250&page=' + pagina;
          $.ajax({ url: url, method: 'GET', dataType: 'json' })
            .done(function (data, ts, xhr) {
              var lote = (xhr && xhr.status === 204) ? [] : ((data && data._embedded && data._embedded.tasks) || []);
              todas = todas.concat(lote);
              if (lote.length === 250 && pagina < MAX_PAGINAS) { pagina++; prox(); return; }
              if (lote.length === 250) parcial = true;
              var vistos = {}, uniq = [];
              todas.forEach(function (t) { if (!vistos[t.id]) { vistos[t.id] = 1; uniq.push(t); } });
              cb(null, uniq, parcial);
            })
            .fail(function (xhr) { cb((xhr && xhr.status) || 'erro', todas, true); });
        }
        prox();
      }

      // ---------------- classificação no servidor ----------------
      function chamarServidor(ids, cb) {
        var c = cfg();
        if (!c.endpoint) { cb('sem_endpoint'); return; }
        var req;
        try {
          req = self.$authorizedAjax({
            url: c.endpoint, method: 'POST', contentType: 'application/json', dataType: 'json',
            data: JSON.stringify({ task_ids: ids })
          });
        } catch (e) { cb('sem_authorizedAjax'); return; }
        var ok = function (r) { cb(null, r); };
        var falha = function (x) {
          var cod = 'erro';
          try { cod = (x && x.responseJSON && x.responseJSON.erro) || (x && x.status) || 'erro'; } catch (e) {}
          cb(cod);
        };
        if (req && typeof req.then === 'function') req.then(ok, falha); else cb('sem_promessa');
      }

      function classificar(cands, cb) {
        var agora = Date.now();
        var faltam = cands.filter(function (t) {
          var em = state.classeEm[t.id];
          return !em || agora - em.t > CACHE_MS || em.upd !== t.updated_at;
        }).map(function (t) { return t.id; });
        if (!faltam.length) { cb(); return; }
        chamarServidor(faltam, function (err, r) {
          if (err || !r || !r.ok) { state.servidor = 'indisponível (' + (err || 'resposta') + ')'; cb(); return; }
          state.servidor = 'ok' + (r.negadas ? ' · ' + r.negadas + ' negadas' : '');
          (r.tarefas || []).forEach(function (c) {
            state.classe[c.id] = c;
            state.classeEm[c.id] = { t: agora, upd: (state.porId[c.id] || {}).updated_at };
            if (c.lead_nome) state.names['leads_' + (state.porId[c.id] || {}).entity_id] = c.lead_nome;
          });
          cb();
        });
      }

      // ---------------- montagem da fila ----------------
      function montar() {
        var c = cfg(), now = agoraS();
        var snooze = lsGet('snooze', {});
        var itens = state.tarefas.filter(function (t) {
          return t.entity_id && !(snooze[t.id] && snooze[t.id] > now);
        }).map(function (t) {
          var k = state.classe[t.id] || Fila.classificarLocal(t);
          return {
            id: t.id, due: t.complete_till || 0, momento: k.momento, grupo: k.grupo || 'G9', urgente: !!k.urgente,
            acao: k.acao, motivo: k.motivo || '', etapa: k.etapa || '', etype: t.entity_type || 'leads', eid: t.entity_id,
            texto: t.text || ''
          };
        });
        var r = Fila.ordenar(itens, { antecedencia_min: c.antecedencia_min, outbound_apos: c.outbound_apos, grupos: c.grupos }, now, minutoDoDia());
        state.fila = r.fila;
        state.futura = r.futura;
      }

      function proximo() {
        var atual = entidadeAtual();
        for (var i = 0; i < state.fila.length; i++) {
          var q = state.fila[i];
          if (atual && q.etype === atual.etype && q.eid === atual.eid) continue;
          return q;
        }
        return null;
      }

      // ---------------- notify ----------------
      function initAudio() { if (state.audio || !state.base) return; try { state.audio = new Audio(state.base + '/notify.mp3'); state.audio.preload = 'auto'; } catch (e) {} }
      function som() { if (!cfg().sound || !state.audio) return; try { state.audio.currentTime = 0; var p = state.audio.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }
      function primeiroClique() {
        var h = function () {
          try { if (state.audio) { state.audio.muted = true; state.audio.play().then(function () { state.audio.pause(); state.audio.currentTime = 0; state.audio.muted = false; }).catch(function () { state.audio.muted = false; }); } } catch (e) {}
          try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
          document.removeEventListener('click', h, true);
        };
        document.addEventListener('click', h, true);
      }
      function notificar() {
        var c = cfg(), now = agoraS(), horizonte = now + c.lookahead * 60, novo = false;
        state.tarefas.forEach(function (t) {
          if (!t.complete_till || t.complete_till > horizonte || state.seen[t.id]) return;
          state.seen[t.id] = 1;
          var k = state.classe[t.id];
          var n = { tid: t.id, titulo: t.text || 'Tarefa', etype: t.entity_type || 'leads', eid: t.entity_id, due: t.complete_till, momento: k ? k.momento : '' };
          state.notif.unshift(n);
          novo = true;
          try {
            if (window.Notification && Notification.permission === 'granted') {
              var no = new Notification(n.titulo, { body: t.complete_till < now ? 'Atrasada' : 'Vence em breve', icon: state.base ? state.base + '/images/icon.png' : undefined, tag: NS + '-' + n.tid });
              no.onclick = function () { window.focus(); abrir(n.etype, n.eid); no.close(); };
            }
          } catch (e) {}
        });
        // some da pilha o que já foi concluído
        var abertas = {}; state.tarefas.forEach(function (t) { abertas[t.id] = 1; });
        state.notif = state.notif.filter(function (n) { return abertas[n.tid]; }).slice(0, 8);
        var ids = Object.keys(state.seen); if (ids.length > 800) { var keep = {}; ids.slice(-800).forEach(function (k2) { keep[k2] = 1; }); state.seen = keep; }
        lsSet('seen', state.seen); lsSet('notif', state.notif);
        if (novo) som();
      }

      // ---------------- ações ----------------
      function concluirEProximo(q) {
        if (!q) return;
        $.ajax({
          url: '/api/v4/tasks/' + encodeURIComponent(q.id), method: 'PATCH', contentType: 'application/json', dataType: 'json',
          data: JSON.stringify({ is_completed: true, result: { text: 'Concluída pelo PRÓXIMO' } })
        }).done(function () {
          state.tarefas = state.tarefas.filter(function (t) { return t.id !== q.id; });
          state.atual = null; montar(); avancar(); ciclo(false);
        }).fail(function (x) { alert('Não consegui concluir a tarefa (' + ((x && x.status) || 'erro') + ').'); });
      }
      function pular(q) {
        if (!q) return;
        var s = lsGet('snooze', {}), now = agoraS();
        Object.keys(s).forEach(function (k) { if (s[k] <= now) delete s[k]; });
        s[q.id] = now + 15 * 60; lsSet('snooze', s);
        state.atual = null; montar(); avancar();
      }
      function avancar() {
        var nx = proximo();
        if (!nx) { render(); return; }
        state.atual = nx; lsSet('atual', nx);
        abrir(nx.etype, nx.eid);
        render();
      }

      // ---------------- CSS / render ----------------
      var CSS = '' +
'.rpv-root{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}' +
'.rpv-root>*{pointer-events:auto}.rpv-bottom-right,.rpv-top-right{right:16px;align-items:flex-end}.rpv-bottom-left,.rpv-top-left{left:16px;align-items:flex-start}' +
'.rpv-pill{display:inline-flex;align-items:stretch;background:#E30613;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.22);overflow:hidden;height:34px}' +
'.rpv-pill.off{background:#6E6C6A;opacity:.75}' +
'.rpv-go{display:inline-flex;align-items:center;gap:7px;background:none;border:0;cursor:pointer;color:#fff;padding:0 12px;font-size:12.5px;font-weight:700;white-space:nowrap}' +
'.rpv-go .cnt{background:rgba(255,255,255,.24);border-radius:999px;padding:1px 7px;font-size:11px}' +
'.rpv-q{background:rgba(0,0,0,.16);border:0;border-left:1px solid rgba(255,255,255,.18);cursor:pointer;color:#fff;width:28px;font-size:10px}' +
'.rpv-card{background:#fff;border:1px solid #E2E1DE;border-radius:12px;width:320px;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.16);overflow:hidden;font-size:12px;color:#1A1A1D}' +
'.rpv-h{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid #EFEEEC;font-weight:700}' +
'.rpv-h .tt{flex:1}.rpv-h button{background:none;border:0;color:#8C8A88;cursor:pointer;font-size:14px}' +
'.rpv-b{padding:9px 12px}.rpv-b .nm{font-weight:700;font-size:13px;margin-bottom:3px}.rpv-b .mt{color:#5C6066;display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
'.rpv-acts{display:flex;gap:6px;padding:0 12px 10px}.rpv-acts button{flex:1;border-radius:7px;border:1px solid #E2E1DE;background:#fff;padding:6px;cursor:pointer;font-weight:600;font-size:12px}' +
'.rpv-acts .pri{background:#E30613;border-color:#E30613;color:#fff}' +
'.rpv-list{max-height:300px;overflow-y:auto}.rpv-it{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid #F4F3F1;cursor:pointer}.rpv-it:hover{background:#FAFAF9}' +
'.rpv-it .pos{width:16px;color:#A5A3A0;text-align:right}.rpv-it .bd{flex:1;min-width:0}.rpv-it .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.rpv-tag{border-radius:4px;padding:1px 5px;font-size:9.5px;font-weight:700;background:#EEF3F8;color:#5C6E80}.rpv-tag.m1{background:#FFE9E9;color:#B4232B}.rpv-tag.m2,.rpv-tag.m3{background:#FFF1E0;color:#A35300}' +
'.rpv-late{color:#B4232B;font-weight:700}.rpv-f{padding:7px 12px;border-top:1px solid #EFEEEC;font-size:10px;color:#8C8A88;display:flex;justify-content:space-between;gap:8px}' +
'.rpv-warn{background:#FFF8E6;color:#8A5A00;padding:6px 12px;font-size:11px}' +
'.rpv-ntf{border-left:4px solid #E30613}.rpv-ntf .rpv-b{cursor:pointer}';

      function css() { if (document.getElementById(NS + '-css')) return; var st = document.createElement('style'); st.id = NS + '-css'; st.textContent = CSS; document.head.appendChild(st); }

      function raiz() {
        var c = document.getElementById(NS + '-root'), conf = cfg();
        if (!c) { c = document.createElement('div'); c.id = NS + '-root'; document.body.appendChild(c); }
        c.className = NS + '-root ' + NS + '-' + conf.position;
        if (conf.position.indexOf('bottom') === 0) { c.style.bottom = conf.offset + 'px'; c.style.top = ''; } else { c.style.top = Math.max(64, conf.offset) + 'px'; c.style.bottom = ''; }
        return c;
      }

      function tag(q) {
        var n = Fila.nivel(q);
        return '<span class="rpv-tag m' + Math.floor(n) + '">' + esc(Fila.ROTULO[q.momento] || 'Outras') + '</span>' +
               (q.grupo && q.grupo !== 'G9' ? '<span class="rpv-tag">' + esc(Fila.ROTULO_GRUPO[q.grupo]) + '</span>' : (q.momento === 'prospeccao' ? '<span class="rpv-tag">origem não informada</span>' : ''));
      }
      function nomeDe(q) { return state.names[q.etype + '_' + q.eid] || ('#' + q.eid); }

      function render() {
        if (!ativoParaEsteUsuario()) return;
        var c = raiz(), now = agoraS(), conf = cfg(), html = '';

        // notificações
        state.notif.slice(0, 3).forEach(function (n) {
          html += '<div class="rpv-card rpv-ntf"><div class="rpv-h"><span class="tt">🔔 ' + esc(Fila.ROTULO[n.momento] || 'Tarefa') + '</span>' +
                  '<button data-act="fechar-ntf" data-tid="' + esc(n.tid) + '" title="Fechar">×</button></div>' +
                  '<div class="rpv-b" data-act="abrir" data-et="' + esc(n.etype) + '" data-eid="' + esc(n.eid) + '"><div class="nm">' + esc(n.titulo) + '</div>' +
                  '<div class="mt"><span' + (n.due < now ? ' class="rpv-late"' : '') + '>' + esc(fmtQuando(n.due, now)) + '</span></div></div></div>';
        });

        // card da tarefa atual (aberta pelo PRÓXIMO)
        var at = state.atual, aqui = entidadeAtual();
        if (at && aqui && at.etype === aqui.etype && at.eid === aqui.eid && state.tarefas.some(function (t) { return t.id === at.id; })) {
          html += '<div class="rpv-card"><div class="rpv-b"><div class="nm">' + esc(nomeDe(at)) + '</div><div class="mt">' + tag(at) +
                  '<span' + (at.due && at.due < now ? ' class="rpv-late"' : '') + '>' + esc(fmtQuando(at.due, now)) + '</span></div>' +
                  '<div class="mt" style="margin-top:4px">' + esc(at.texto).slice(0, 160) + '</div></div>' +
                  '<div class="rpv-acts"><button class="pri" data-act="concluir">Concluir e próximo</button><button data-act="pular">Pular 15 min</button></div></div>';
        }

        // painel da fila
        if (state.open) {
          html += '<div class="rpv-card"><div class="rpv-h"><span class="tt">Sua fila · ' + state.fila.length + '</span>' +
                  '<button data-act="atualizar" title="Atualizar">↻</button><button data-act="painel" title="Fechar">×</button></div>';
          if (state.parcial) html += '<div class="rpv-warn">Fila parcial: há tarefas demais para classificar todas agora.</div>';
          if (state.servidor.indexOf('ok') !== 0) html += '<div class="rpv-warn">Classificação ' + esc(state.servidor) + ' — ordem só por vencimento.</div>';
          if (!state.fila.length) {
            html += '<div class="rpv-b">' + (state.futura ? 'Nada vencido. Próxima às <b>' + esc(fmtQuando(state.futura.due, now)) + '</b>.' : 'Nenhuma tarefa pendente.') + '</div>';
          } else {
            html += '<div class="rpv-list">';
            state.fila.slice(0, 15).forEach(function (q, i) {
              html += '<div class="rpv-it" data-act="ir" data-i="' + i + '"><span class="pos">' + (i + 1) + '</span><span class="bd"><div class="nm">' + esc(nomeDe(q)) + '</div>' +
                      '<div class="mt">' + tag(q) + '<span' + (q.due && q.due < now ? ' class="rpv-late"' : '') + '>' + esc(fmtQuando(q.due, now)) + '</span></div></span></div>';
            });
            html += '</div>';
          }
          html += '<div class="rpv-f"><span>servidor: ' + esc(state.servidor) + '</span>' + (conf.atalho ? '<span>Alt+N</span>' : '') + '</div></div>';
        }

        var nx = proximo();
        html += '<span class="rpv-pill' + (nx ? '' : ' off') + '" title="' + esc(nx ? nomeDe(nx) + ' · ' + (Fila.ROTULO[nx.momento] || '') : (state.futura ? 'nada vencido' : 'sem tarefas')) + '">' +
                '<button class="rpv-go" ' + (nx ? 'data-act="avancar"' : 'disabled') + '>➜ Próximo' + (state.fila.length ? '<span class="cnt">' + state.fila.length + '</span>' : '') + '</button>' +
                '<button class="rpv-q" data-act="painel" title="Ver a fila">' + (state.open ? '▾' : '▴') + '</button></span>';
        c.innerHTML = html;
      }

      function bind() {
        var c = document.getElementById(NS + '-root');
        if (!c || c.getAttribute('data-bound') === '1') return;
        c.setAttribute('data-bound', '1');
        c.addEventListener('click', function (ev) {
          var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
          if (!el) return;
          var act = el.getAttribute('data-act');
          if (act === 'avancar') avancar();
          else if (act === 'painel') { state.open = !state.open; render(); }
          else if (act === 'atualizar') ciclo(true);
          else if (act === 'concluir') concluirEProximo(state.atual);
          else if (act === 'pular') pular(state.atual);
          else if (act === 'ir') { var q = state.fila[parseInt(el.getAttribute('data-i'), 10)]; if (q) { state.atual = q; lsSet('atual', q); abrir(q.etype, q.eid); render(); } }
          else if (act === 'abrir') abrir(el.getAttribute('data-et'), el.getAttribute('data-eid'));
          else if (act === 'fechar-ntf') { var tid = String(el.getAttribute('data-tid')); state.notif = state.notif.filter(function (n) { return String(n.tid) !== tid; }); lsSet('notif', state.notif); render(); }
        });
      }

      function atalho() {
        if (window[NS + '_kb']) return; window[NS + '_kb'] = true;
        document.addEventListener('keydown', function (ev) {
          if (!cfg().atalho || !ev.altKey || ev.ctrlKey || ev.metaKey || String(ev.key).toLowerCase() !== 'n') return;
          var t = ev.target && ev.target.tagName;
          if (t === 'INPUT' || t === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
          ev.preventDefault(); avancar();
        });
      }

      // ---------------- ciclo ----------------
      function ciclo(manual) {
        if (!state.uid || !ativoParaEsteUsuario() || state.loading) return;
        state.loading = true;
        if (manual) render();
        lerTarefas(function (err, tarefas, parcialLeitura) {
          if (err && !tarefas.length) { state.loading = false; state.servidor = state.servidor || 'erro'; render(); return; }
          state.tarefas = tarefas;
          state.porId = {}; tarefas.forEach(function (t) { state.porId[t.id] = t; });
          var c = cfg(), cand = Fila.candidatas(tarefas, agoraS(), c.antecedencia_min, MAX_CLASSIF);
          state.parcial = parcialLeitura || cand.parcial;
          classificar(cand.lista, function () {
            state.loading = false;
            montar(); notificar(); render();
          });
        });
      }

      function boot() {
        if (state.booted) { raiz(); bind(); render(); return; }
        var sys = {};
        try { sys = self.system() || {}; } catch (e) { sys = {}; }
        state.uid = sys.user_id || (window.AMOCRM && AMOCRM.constant && AMOCRM.constant('user') && AMOCRM.constant('user').id) || null;
        state.sub = sys.subdomain || location.hostname.split('.')[0] || 'acc';
        if (!state.uid || !ativoParaEsteUsuario()) return;   // fora da lista de teste: widget inerte
        state.booted = true;
        var p = self.params || {};
        state.base = String(p.cdn_path || p.path || '').replace(/\/+$/, '');
        state.seen = lsGet('seen', {}); state.notif = lsGet('notif', []); state.atual = lsGet('atual', null);
        css(); raiz(); bind(); atalho(); initAudio(); primeiroClique();
        render(); ciclo(false);
        state.timer = setInterval(function () { raiz(); bind(); ciclo(false); }, cfg().poll * 1000);
        // re-render ao navegar (o card "atual" depende da URL)
        var ultima = location.pathname;
        setInterval(function () { if (location.pathname !== ultima) { ultima = location.pathname; render(); } }, 700);
      }

      this.callbacks = {
        render: function () { return true; },
        init: function () { try { boot(); } catch (e) { if (window.console) console.error('[ruston-prevendas] init', e); } return true; },
        bind_actions: function () { return true; },
        settings: function () { return true; },
        onSave: function () { return true; },
        destroy: function () {
          try { if (state.timer) clearInterval(state.timer); } catch (e) {}
          var c = document.getElementById(NS + '-root'); if (c && c.parentNode) c.parentNode.removeChild(c);
        }
      };
      return this;
    };
    return CustomWidget;
  });
})();
