/**
 * Ruston Próximo Lead — widget privado do Kommo (Web SDK).
 *
 * O QUE FAZ
 * Botão fixo na tela que leva o SDR para a próxima tarefa da fila, já ordenada.
 * Mostra também um painel com as próximas da fila, para ele saber o que vem.
 *
 * REGRA DE ORDENAÇÃO (a parte que importa)
 *   1) Tarefas ANCORADAS EM HORÁRIO cujo horário já venceu (ou vence dentro da
 *      antecedência configurada) — estas CORTAM A FILA. Ordenadas por vencimento.
 *      Por padrão: Acompanhar · Reunião · Diagnóstico de Marketing · ALERTA.
 *   2) Cadência, que não depende de horário: Ligação · WhatsApp · Email.
 *      Ordenadas por vencimento.
 *   3) Tarefas ancoradas AINDA NO FUTURO, por ordem de vencimento.
 *
 * O efeito prático do item 1: o SDR pode estar prospectando a base a manhã
 * inteira e, quando bate o horário de um acompanhamento, ele atravessa a fila
 * e vira o próximo — sem o SDR precisar lembrar.
 *
 * GATILHO: polling da API de Tarefas (/api/v4/tasks). Front puro, SEM backend.
 * Namespace: prefixo "rnl-" / "rnl_" para não colidir com o Kommo.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;

    var NS = 'rnl';
    var DEFAULTS = {
      prioridade: 'Acompanhar, Reuniao, Diagnostico, ALERTA',
      antecedencia: 5,
      position: 'bottom-right',
      poll_seconds: 45,
      atalho: 'Y',
      offset: 96
    };
    var POS_WHITELIST = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

    var state = {
      timer: null,
      booted: false,
      uid: null,
      sub: 'acc',
      base: '',
      taskTypes: {},   // {id: nome}
      names: {},       // {etype_eid: nome}
      queue: [],       // fila ordenada de tarefas
      open: false,     // painel aberto?
      loading: false,
      lastErr: null
    };

    // ================= helpers =================
    function cfg() {
      var s = {};
      try { s = self.get_settings() || {}; } catch (e) { s = {}; }

      var pos = String(s.position || DEFAULTS.position).trim().toLowerCase();
      if (POS_WHITELIST.indexOf(pos) === -1) pos = DEFAULTS.position;

      var poll = parseInt(s.poll_seconds, 10);
      if (!poll || poll < 15) poll = DEFAULTS.poll_seconds;

      var ant = parseInt(s.antecedencia, 10);
      if (isNaN(ant) || ant < 0) ant = DEFAULTS.antecedencia;

      var raw = String(s.prioridade || DEFAULTS.prioridade);
      var prio = raw.split(',').map(function (x) { return norm(x); }).filter(Boolean);

      var atalho = String(s.atalho || DEFAULTS.atalho).trim().toUpperCase() !== 'N';

      var off = parseInt(s.offset, 10);
      if (isNaN(off) || off < 0) off = DEFAULTS.offset;
      if (off > 400) off = 400;

      return { position: pos, poll: poll, antecedencia: ant, prio: prio, atalho: atalho, offset: off };
    }

    // normaliza para comparar nome de tipo de tarefa sem acento e sem caixa
    function norm(s) {
      var v = (s == null) ? '' : String(s);
      try { if (v.normalize) v = v.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
      return v.trim().toLowerCase();
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function fmtHora(unix) {
      if (!unix) return '';
      var d = new Date(unix * 1000);
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function fmtQuando(unix, now) {
      if (!unix) return '';
      var diff = unix - now;
      var d = new Date(unix * 1000);
      var hoje = new Date(now * 1000);
      var mesmoDia = d.toDateString() === hoje.toDateString();

      if (diff < 0) {
        var atraso = Math.floor(-diff / 60);
        if (atraso < 60) return 'atrasada ' + atraso + 'min';
        if (atraso < 60 * 24) return 'atrasada ' + Math.floor(atraso / 60) + 'h';
        return 'atrasada ' + Math.floor(atraso / 1440) + 'd';
      }
      if (mesmoDia) return fmtHora(unix);
      if (diff < 60 * 60 * 48) return 'amanhã ' + fmtHora(unix);
      return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + fmtHora(unix);
    }

    // ================= navegação =================
    function segFor(etype) {
      var m = { leads: 'leads', contacts: 'contacts', companies: 'companies', customers: 'customers' };
      return m[etype] || 'leads';
    }

    function detailPath(etype, eid) { return '/' + segFor(etype) + '/detail/' + eid; }

    function openEntity(etype, eid) {
      var path = detailPath(etype, eid);
      try {
        if (window.AMOCRM && AMOCRM.Router && typeof AMOCRM.Router.navigate === 'function') {
          AMOCRM.Router.navigate(path, { trigger: true });
          return;
        }
      } catch (e) {}
      try {
        if (window.AMOCRM && typeof AMOCRM.redirect === 'function') { AMOCRM.redirect(path); return; }
      } catch (e) {}
      window.location.href = location.origin + path;
    }

    // qual entidade está aberta agora? (para não "avançar" para onde já estamos)
    function entidadeAtual() {
      var m = String(location.pathname).match(/\/(leads|contacts|companies|customers)\/detail\/(\d+)/);
      if (!m) return null;
      return { etype: m[1], eid: parseInt(m[2], 10) };
    }

    // ================= ordenação da fila =================
    function ehPrioritaria(t, c) {
      var nome = norm(state.taskTypes[t.task_type_id] || '');
      if (!nome) return false;
      for (var i = 0; i < c.prio.length; i++) {
        // casa por conter, para pegar "Acompanhar cliente", "Follow-up 2" etc.
        if (nome.indexOf(c.prio[i]) !== -1 || c.prio[i].indexOf(nome) !== -1) return true;
      }
      return false;
    }

    function porVencimento(a, b) {
      return (a.complete_till || 0) - (b.complete_till || 0);
    }

    /**
     * Monta a fila em três blocos. O bloco 1 é o que dá o comportamento de
     * "atravessar a fila": assim que um acompanhamento vence, ele sai do
     * bloco 3 e entra no bloco 1, virando o próximo automaticamente.
     */
    function montarFila(tasks, c, now) {
      var limite = now + c.antecedencia * 60;
      var acompVencido = [], cadencia = [], acompFuturo = [];

      tasks.forEach(function (t) {
        if (!t.entity_id) return;
        var prio = ehPrioritaria(t, c);
        var venceu = t.complete_till && t.complete_till <= limite;
        if (prio && venceu) acompVencido.push(t);
        else if (prio) acompFuturo.push(t);
        else cadencia.push(t);
      });

      acompVencido.sort(porVencimento);
      cadencia.sort(porVencimento);
      acompFuturo.sort(porVencimento);

      return acompVencido.concat(cadencia, acompFuturo).map(function (t) {
        return {
          tid: t.id,
          texto: t.text || '',
          ttype: t.task_type_id || null,
          tnome: state.taskTypes[t.task_type_id] || 'Tarefa',
          etype: t.entity_type || 'leads',
          eid: t.entity_id,
          due: t.complete_till || 0,
          prioritaria: ehPrioritaria(t, c),
          atrasada: t.complete_till ? t.complete_till < now : false
        };
      });
    }

    // qual é o próximo destino? pula a entidade que já está aberta
    function proximo() {
      var atual = entidadeAtual();
      for (var i = 0; i < state.queue.length; i++) {
        var q = state.queue[i];
        if (atual && q.etype === atual.etype && q.eid === atual.eid) continue;
        return q;
      }
      return null;
    }

    // ================= CSS =================
    var CSS_INLINE = '' +
'.rnl-root{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:8px;' +
'  pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}' +
'.rnl-root>*{pointer-events:auto}' +
'.rnl-bottom-right{right:16px;align-items:flex-end}' +
'.rnl-bottom-left{left:16px;align-items:flex-start}' +
'.rnl-top-right{right:16px;align-items:flex-end}' +
'.rnl-top-left{left:16px;align-items:flex-start}' +
/* ---- pastilha compacta: um controle, não um card ---- */
'.rnl-pill{display:inline-flex;align-items:stretch;background:#E30613;border-radius:999px;' +
'  box-shadow:0 2px 10px rgba(0,0,0,.22);overflow:hidden;height:34px;' +
'  transition:box-shadow .14s,opacity .14s;opacity:.94}' +
'.rnl-pill:hover{opacity:1;box-shadow:0 4px 14px rgba(227,6,19,.34)}' +
'.rnl-go{display:inline-flex;align-items:center;gap:7px;background:none;border:0;cursor:pointer;' +
'  color:#fff;padding:0 11px 0 12px;font-size:12.5px;font-weight:700;letter-spacing:-.005em;' +
'  white-space:nowrap;height:100%}' +
'.rnl-go .ico{flex:0 0 auto;width:14px;height:14px;display:block}' +
'.rnl-go .cnt{background:rgba(255,255,255,.24);border-radius:999px;padding:1px 7px;' +
'  font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;margin-left:1px}' +
'.rnl-q{display:inline-flex;align-items:center;justify-content:center;background:rgba(0,0,0,.16);' +
'  border:0;border-left:1px solid rgba(255,255,255,.18);cursor:pointer;color:#fff;width:28px;' +
'  font-size:10px;height:100%;padding:0}' +
'.rnl-q:hover{background:rgba(0,0,0,.28)}' +
'.rnl-pill.off{background:#6E6C6A;opacity:.7;box-shadow:none}' +
'.rnl-pill.off .rnl-go{cursor:default}' +
/* ---- dica no hover: quem é o próximo, sem ocupar espaço fixo ---- */
'.rnl-tip{position:absolute;bottom:calc(100% + 7px);right:0;background:#1A1A1D;color:#fff;' +
'  border-radius:9px;padding:7px 10px;font-size:11.5px;line-height:1.35;white-space:nowrap;' +
'  max-width:280px;overflow:hidden;text-overflow:ellipsis;opacity:0;pointer-events:none;' +
'  transform:translateY(3px);transition:opacity .13s,transform .13s;box-shadow:0 5px 18px rgba(0,0,0,.3)}' +
'.rnl-tipwrap{position:relative;display:inline-block}' +
'.rnl-tipwrap:hover .rnl-tip{opacity:1;transform:translateY(0)}' +
'.rnl-tip b{color:#fff}.rnl-tip i{font-style:normal;color:#A5A3A0}' +
'.rnl-top-right .rnl-tip,.rnl-top-left .rnl-tip{bottom:auto;top:calc(100% + 7px);transform:translateY(-3px)}' +
'.rnl-bottom-left .rnl-tip,.rnl-top-left .rnl-tip{right:auto;left:0}' +
/* ---- painel da fila ---- */
'.rnl-panel{background:#fff;border:1px solid #E2E1DE;border-radius:13px;width:320px;' +
'  max-width:calc(100vw - 32px);box-shadow:0 10px 34px rgba(0,0,0,.16);overflow:hidden}' +
'.rnl-ph{display:flex;align-items:center;gap:6px;padding:11px 13px;border-bottom:1px solid #EFEEEC}' +
'.rnl-ph .tt{flex:1;font-size:12.5px;font-weight:700;color:#1A1A1D}' +
'.rnl-ph button{background:none;border:0;color:#8C8A88;cursor:pointer;font-size:14px;line-height:1;' +
'  padding:3px 5px;border-radius:6px}' +
'.rnl-ph button:hover{color:#1A1A1D;background:#F4F3F1}' +
'.rnl-list{max-height:300px;overflow-y:auto}' +
'.rnl-item{display:flex;gap:9px;padding:9px 13px;border-bottom:1px solid #F4F3F1;cursor:pointer;' +
'  align-items:flex-start}' +
'.rnl-item:last-child{border-bottom:0}' +
'.rnl-item:hover{background:#FAFAF9}' +
'.rnl-item.here{background:#FFF6F6}' +
'.rnl-item .pos{flex:0 0 16px;font-size:10.5px;color:#A5A3A0;font-variant-numeric:tabular-nums;' +
'  padding-top:2px;text-align:right}' +
'.rnl-item .bd{flex:1;min-width:0}' +
'.rnl-item .nm{font-size:12.5px;font-weight:600;color:#1A1A1D;line-height:1.3;' +
'  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.rnl-item .mt{font-size:10.5px;color:#8C8A88;margin-top:2px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
'.rnl-tag{border-radius:4px;padding:1px 5px;font-size:9.5px;font-weight:700}' +
'.rnl-tag.p{background:#FFE9E9;color:#B4232B}' +
'.rnl-tag.c{background:#EEF3F8;color:#5C6E80}' +
'.rnl-late{color:#B4232B;font-weight:700}' +
'.rnl-here-b{background:#E30613;color:#fff;border-radius:4px;padding:1px 5px;font-size:9px;font-weight:700}' +
'.rnl-empty{padding:22px 16px;text-align:center;color:#8C8A88;font-size:12px}' +
'.rnl-empty b{display:block;color:#1A1A1D;font-size:13px;margin-bottom:4px}' +
'.rnl-foot{padding:8px 13px;border-top:1px solid #EFEEEC;font-size:10px;color:#A5A3A0;' +
'  display:flex;justify-content:space-between;gap:8px;align-items:center}' +
'.rnl-kbd{border:1px solid #DDD;border-bottom-width:2px;border-radius:3px;padding:0 3px;' +
'  font-family:ui-monospace,monospace;font-size:9.5px;color:#5C6066;background:#FAFAF9}';

    function injectCss() {
      if (document.getElementById(NS + '-css')) return;
      var st = document.createElement('style');
      st.id = NS + '-css';
      st.textContent = CSS_INLINE;
      document.head.appendChild(st);
    }

    var ICON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h12"/><path d="M11.5 6l6 6-6 6"/></svg>';

    // ================= render =================
    function container() {
      var c = document.getElementById(NS + '-root');
      var conf = cfg();
      if (!c) {
        c = document.createElement('div');
        c.id = NS + '-root';
        document.body.appendChild(c);
      }
      c.className = 'rnl-root rnl-' + conf.position;
      // distância da borda: por padrão 96px, pra não cobrir a caixa de conversa do Kommo
      if (conf.position.indexOf('bottom') === 0) { c.style.bottom = conf.offset + 'px'; c.style.top = ''; }
      else { c.style.top = Math.max(64, conf.offset) + 'px'; c.style.bottom = ''; }
      return c;
    }

    function render() {
      var c = container();
      var now = Math.floor(Date.now() / 1000);
      var nx = proximo();
      var total = state.queue.length;
      var atual = entidadeAtual();
      var conf = cfg();
      var html = '';

      // ---- painel da fila (só quando aberto) ----
      if (state.open) {
        html += '<div class="rnl-panel">';
        html += '<div class="rnl-ph"><span class="tt">Sua fila · ' + total + '</span>' +
                '<button data-act="atualizar" title="Atualizar">↻</button>' +
                '<button data-act="fechar" title="Fechar">×</button></div>';
        if (!total) {
          html += '<div class="rnl-empty"><b>Nenhuma tarefa pendente</b>' +
                  (state.lastErr ? 'Não consegui carregar a fila agora.' : 'Fila limpa.') + '</div>';
        } else {
          html += '<div class="rnl-list">';
          state.queue.slice(0, 12).forEach(function (q, i) {
            var aqui = atual && q.etype === atual.etype && q.eid === atual.eid;
            var nome = state.names[q.etype + '_' + q.eid] || ('#' + q.eid);
            html += '<div class="rnl-item' + (aqui ? ' here' : '') + '" data-act="ir" data-i="' + i + '">';
            html += '<span class="pos">' + (i + 1) + '</span><span class="bd">';
            html += '<span class="nm">' + esc(nome) + '</span><span class="mt">';
            html += '<span class="rnl-tag ' + (q.prioritaria ? 'p' : 'c') + '">' + esc(q.tnome) + '</span>';
            html += '<span' + (q.atrasada ? ' class="rnl-late"' : '') + '>' + esc(fmtQuando(q.due, now)) + '</span>';
            if (aqui) html += '<span class="rnl-here-b">aqui</span>';
            html += '</span></span></div>';
          });
          html += '</div>';
          html += '<div class="rnl-foot"><span>Horário vencido corta a fila</span>' +
                  (conf.atalho ? '<span><span class="rnl-kbd">Alt</span>+<span class="rnl-kbd">N</span></span>' : '') +
                  '</div>';
        }
        html += '</div>';
      }

      // ---- pastilha: um controle só, com a dica no hover ----
      var tip = '';
      if (nx) {
        var nome2 = state.names[nx.etype + '_' + nx.eid] || ('#' + nx.eid);
        tip = '<span class="rnl-tip"><b>' + esc(nome2) + '</b><br><i>' +
              esc(nx.tnome) + ' · ' + esc(fmtQuando(nx.due, now)) + '</i></span>';
      } else if (total) {
        tip = '<span class="rnl-tip"><i>esta é a única tarefa pendente</i></span>';
      } else {
        tip = '<span class="rnl-tip"><i>' + (state.loading ? 'carregando…' : 'nenhuma tarefa pendente') + '</i></span>';
      }

      html += '<span class="rnl-tipwrap">' + tip +
              '<span class="rnl-pill' + (nx ? '' : ' off') + '">' +
              '<button class="rnl-go"' + (nx ? ' data-act="avancar"' : ' disabled') + '>' +
              ICON + '<span>Próximo</span>' +
              (total ? '<span class="cnt">' + total + '</span>' : '') +
              '</button>' +
              '<button class="rnl-q" data-act="painel" title="Ver a fila">' + (state.open ? '▾' : '▴') + '</button>' +
              '</span></span>';

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
        if (act === 'avancar') { avancar(); }
        else if (act === 'painel') { state.open = !state.open; render(); }
        else if (act === 'fechar') { state.open = false; render(); }
        else if (act === 'atualizar') { poll(true); }
        else if (act === 'ir') {
          var q = state.queue[parseInt(el.getAttribute('data-i'), 10)];
          if (q) openEntity(q.etype, q.eid);
        }
      });
    }

    function avancar() {
      var nx = proximo();
      if (!nx) return;
      openEntity(nx.etype, nx.eid);
    }

    function bindAtalho() {
      if (window[NS + '_kb']) return;
      window[NS + '_kb'] = true;
      document.addEventListener('keydown', function (ev) {
        if (!cfg().atalho) return;
        if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
        if (String(ev.key).toLowerCase() !== 'n') return;
        var t = ev.target && ev.target.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
        ev.preventDefault();
        avancar();
      });
    }

    // ================= API =================
    function loadTaskTypes(cb) {
      $.ajax({ url: '/api/v4/account?with=task_types', method: 'GET', dataType: 'json' })
        .done(function (acc) {
          try {
            var tt = (acc && acc._embedded && acc._embedded.task_types) || [];
            tt.forEach(function (t) { state.taskTypes[t.id] = t.name; });
          } catch (e) {}
          if (cb) cb();
        })
        .fail(function () { if (cb) cb(); });
    }

    function fetchNames(items) {
      var byType = {};
      items.forEach(function (q) {
        var key = q.etype + '_' + q.eid;
        if (state.names[key] || !q.eid) return;
        (byType[q.etype] = byType[q.etype] || []).push(q.eid);
      });
      Object.keys(byType).forEach(function (etype) {
        var ids = byType[etype].slice(0, 50);
        if (!ids.length) return;
        var q = ids.map(function (id) { return 'filter[id][]=' + encodeURIComponent(id); }).join('&');
        $.ajax({ url: '/api/v4/' + etype + '?' + q + '&limit=50', method: 'GET', dataType: 'json' })
          .done(function (data) {
            try {
              var arr = (data && data._embedded && data._embedded[etype]) || [];
              arr.forEach(function (e) { state.names[etype + '_' + e.id] = e.name || ''; });
              render();
            } catch (e) {}
          });
      });
    }

    function poll(manual) {
      if (!state.uid) return;
      state.loading = true;
      if (manual) render();
      var url = '/api/v4/tasks?filter[responsible_user_id]=' + encodeURIComponent(state.uid) +
                '&filter[is_completed]=0&order[complete_till]=asc&limit=250';
      $.ajax({ url: url, method: 'GET', dataType: 'json' })
        .done(function (data, textStatus, xhr) {
          state.loading = false;
          state.lastErr = null;
          var tasks = (xhr && xhr.status === 204) ? [] : ((data && data._embedded && data._embedded.tasks) || []);
          var now = Math.floor(Date.now() / 1000);
          state.queue = montarFila(tasks, cfg(), now);
          render();
          fetchNames(state.queue.slice(0, 12));
        })
        .fail(function (xhr) {
          state.loading = false;
          state.lastErr = (xhr && xhr.status) || 'erro';
          render();
        });
    }

    function startLoop() {
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(function () { poll(false); }, cfg().poll * 1000);
    }

    // ================= bootstrap =================
    function boot() {
      if (state.booted) { container(); bind(); render(); return; }
      state.booted = true;

      var sys = {};
      try { sys = self.system() || {}; } catch (e) { sys = {}; }
      state.uid = sys.user_id ||
        (window.AMOCRM && AMOCRM.constant && AMOCRM.constant('user') && AMOCRM.constant('user').id) || null;
      state.sub = sys.subdomain || location.hostname.split('.')[0] || 'acc';

      var wcode = '';
      try { wcode = (self.get_settings && self.get_settings().widget_code) || ''; } catch (e) {}
      var p = self.params || {};
      state.base = String(p.cdn_path || p.path || (wcode ? '/widgets/' + wcode : '')).replace(/\/+$/, '');

      injectCss();
      container();
      bind();
      bindAtalho();
      render();
      loadTaskTypes(function () { poll(false); });
      startLoop();
    }

    // ================= callbacks do Kommo =================
    this.callbacks = {
      render: function () { return true; },
      init: function () {
        try { boot(); } catch (e) { if (window.console) console.error('[ruston-next-lead] init', e); }
        return true;
      },
      bind_actions: function () { return true; },
      settings: function () { return true; },
      onSave: function () { return true; },
      destroy: function () {
        try { if (state.timer) clearInterval(state.timer); } catch (e) {}
        var c = document.getElementById(NS + '-root');
        if (c && c.parentNode) c.parentNode.removeChild(c);
      }
    };

    return this;
  };
  return CustomWidget;
});
