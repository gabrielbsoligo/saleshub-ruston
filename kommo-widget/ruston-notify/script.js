/**
 * Ruston Notify — widget privado do Kommo (Web SDK).
 * Pop-up persistente de tarefa/evento: fica na tela até o SDR fechar,
 * reaparece ao navegar, empilha, toca som e dispara Notification do browser.
 *
 * GATILHO: polling leve da API de Tarefas do Kommo (/api/v4/tasks) — front
 * puro, SEM backend. Ver README pro porquê e pro caminho opcional via
 * digital_pipeline + webhook.
 *
 * Namespace: classes/estado com prefixo "rnw-" / "rnw_" pra não colidir.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;

    // ---- namespace / defaults ----
    var NS = 'rnw';
    var DEFAULTS = { position: 'bottom-right', sound: 'Y', poll_seconds: 45, lookahead_min: 15 };
    var POS_WHITELIST = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

    var state = {
      timer: null,
      audio: null,
      base: '',          // cdn_path dos arquivos do widget
      uid: null,         // id do usuário logado
      sub: 'acc',        // subdomínio (namespacing do storage)
      booted: false,
      active: [],        // notificações na tela [{tid,title,body,etype,eid,due}]
      seen: {},          // ids de tarefa já exibidas (não re-popar)
    };

    // ---------- helpers ----------
    function cfg() {
      var s = {};
      try { s = self.get_settings() || {}; } catch (e) { s = {}; }
      var pos = (s.position || DEFAULTS.position).toString().trim().toLowerCase();
      if (POS_WHITELIST.indexOf(pos) === -1) pos = DEFAULTS.position;
      var poll = parseInt(s.poll_seconds, 10); if (!poll || poll < 15) poll = DEFAULTS.poll_seconds;
      var look = parseInt(s.lookahead_min, 10); if (isNaN(look) || look < 0) look = DEFAULTS.lookahead_min;
      var sound = (s.sound || DEFAULTS.sound).toString().toUpperCase() !== 'N';
      return { position: pos, poll: poll, lookahead: look, sound: sound };
    }

    function keyActive() { return NS + '_active_' + state.sub + '_' + state.uid; }
    function keySeen() { return NS + '_seen_' + state.sub + '_' + state.uid; }

    function loadState() {
      try { state.active = JSON.parse(localStorage.getItem(keyActive()) || '[]') || []; } catch (e) { state.active = []; }
      try { state.seen = JSON.parse(localStorage.getItem(keySeen()) || '{}') || {}; } catch (e) { state.seen = {}; }
    }
    function saveState() {
      try { localStorage.setItem(keyActive(), JSON.stringify(state.active)); } catch (e) {}
      try {
        // poda o "seen" pra não crescer pra sempre (mantém últimos 500)
        var ids = Object.keys(state.seen);
        if (ids.length > 500) { var keep = {}; ids.slice(-500).forEach(function (k) { keep[k] = 1; }); state.seen = keep; }
        localStorage.setItem(keySeen(), JSON.stringify(state.seen));
      } catch (e) {}
    }

    function detailUrl(etype, eid) {
      var map = { leads: 'leads', contacts: 'contacts', companies: 'companies', customers: 'customers' };
      var seg = map[etype] || 'leads';
      return location.origin + '/' + seg + '/detail/' + eid;
    }

    function fmtDue(unix) {
      if (!unix) return '';
      try {
        var d = new Date(unix * 1000);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      } catch (e) { return ''; }
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // ---------- assets: CSS + som ----------
    function injectCss() {
      if (document.getElementById(NS + '-css')) return;
      var href = state.base ? state.base + '/style.css' : null;
      if (!href) return;
      var l = document.createElement('link');
      l.id = NS + '-css'; l.rel = 'stylesheet'; l.type = 'text/css'; l.href = href;
      document.head.appendChild(l);
    }
    function initAudio() {
      if (state.audio || !state.base) return;
      try { state.audio = new Audio(state.base + '/notify.mp3'); state.audio.preload = 'auto'; } catch (e) {}
    }
    function playSound() {
      if (!cfg().sound || !state.audio) return;
      try { state.audio.currentTime = 0; var p = state.audio.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
    }

    // Autoplay/permite som após 1º gesto; pede permissão de Notification 1x.
    function primeOnGesture() {
      var handler = function () {
        try { if (state.audio) { state.audio.muted = true; state.audio.play().then(function () { state.audio.pause(); state.audio.currentTime = 0; state.audio.muted = false; }).catch(function () { state.audio.muted = false; }); } } catch (e) {}
        askNotifyPermission();
        document.removeEventListener('click', handler, true);
      };
      document.addEventListener('click', handler, true);
    }
    function askNotifyPermission() {
      try {
        if (window.Notification && Notification.permission === 'default') {
          Notification.requestPermission().catch(function () {});
        }
      } catch (e) {}
    }
    function pushBrowserNotif(n) {
      try {
        if (window.Notification && Notification.permission === 'granted') {
          var icon = state.base ? state.base + '/images/icon.png' : undefined;
          var no = new Notification(n.title, { body: n.body, icon: icon, tag: NS + '-' + n.tid, renotify: true });
          no.onclick = function () { window.focus(); window.open(detailUrl(n.etype, n.eid), '_blank'); no.close(); };
        }
      } catch (e) {}
    }

    // ---------- overlay / render ----------
    function ensureContainer() {
      var c = document.getElementById(NS + '-root');
      if (!c) {
        c = document.createElement('div');
        c.id = NS + '-root';
        document.body.appendChild(c);
      }
      c.className = NS + '-root ' + NS + '-' + cfg().position;
      return c;
    }

    function render() {
      var c = ensureContainer();
      if (!state.active.length) { c.innerHTML = ''; return; }
      var html = '';
      for (var i = 0; i < state.active.length; i++) {
        var n = state.active[i];
        html +=
          '<div class="' + NS + '-card" data-tid="' + esc(n.tid) + '">' +
            '<div class="' + NS + '-head">' +
              '<span class="' + NS + '-badge">🔔 Tarefa</span>' +
              '<button class="' + NS + '-close" data-tid="' + esc(n.tid) + '" title="Fechar" aria-label="Fechar">×</button>' +
            '</div>' +
            '<div class="' + NS + '-title">' + esc(n.title) + '</div>' +
            (n.body ? '<div class="' + NS + '-body">' + esc(n.body) + '</div>' : '') +
            (n.due ? '<div class="' + NS + '-due">⏰ ' + esc(fmtDue(n.due)) + '</div>' : '') +
            '<div class="' + NS + '-actions">' +
              '<a class="' + NS + '-open" href="' + esc(detailUrl(n.etype, n.eid)) + '" target="_blank" rel="noopener">Abrir ' +
                (n.etype === 'contacts' ? 'contato' : n.etype === 'companies' ? 'empresa' : 'lead') + ' ↗</a>' +
            '</div>' +
          '</div>';
      }
      c.innerHTML = html;
    }

    function bindOverlay() {
      var c = document.getElementById(NS + '-root');
      if (!c || c.getAttribute('data-bound')) return;
      c.setAttribute('data-bound', '1');
      // delegação: sobrevive a re-render
      $(c).on('click', '.' + NS + '-close', function () {
        var tid = String($(this).attr('data-tid'));
        state.active = state.active.filter(function (n) { return String(n.tid) !== tid; });
        saveState(); render();
      });
    }

    function addNotif(n) {
      if (state.seen[n.tid]) return false;
      state.seen[n.tid] = 1;
      // já está na tela? (defensivo)
      if (state.active.some(function (x) { return String(x.tid) === String(n.tid); })) return false;
      state.active.unshift(n);
      if (state.active.length > 12) state.active = state.active.slice(0, 12);
      return true;
    }

    // ---------- polling da API de Tarefas ----------
    function poll() {
      if (!state.uid) return;
      var c = cfg();
      var url = '/api/v4/tasks?filter[responsible_user_id]=' + encodeURIComponent(state.uid) +
                '&filter[is_completed]=0&order[complete_till]=asc&limit=100';
      $.ajax({ url: url, method: 'GET', dataType: 'json' })
        .done(function (data, textStatus, xhr) {
          if (xhr && xhr.status === 204) return;            // sem tarefas
          var tasks = (data && data._embedded && data._embedded.tasks) || [];
          var now = Math.floor(Date.now() / 1000);
          var horizon = now + c.lookahead * 60;
          var fired = false;
          for (var i = 0; i < tasks.length; i++) {
            var t = tasks[i];
            // "importante" = vence dentro da janela (ou já atrasada)
            if (t.complete_till && t.complete_till <= horizon) {
              var n = {
                tid: t.id,
                title: t.text || 'Tarefa sem título',
                body: (t.complete_till < now ? 'Atrasada' : 'Vence em breve'),
                etype: t.entity_type || 'leads',
                eid: t.entity_id,
                due: t.complete_till,
              };
              if (addNotif(n)) { fired = true; pushBrowserNotif(n); }
            }
          }
          if (fired) { playSound(); saveState(); }
          render();
        })
        .fail(function () { /* silencioso: rede/permissão — tenta no próximo tick */ });
    }

    function startLoop() {
      if (state.timer) clearInterval(state.timer);
      var ms = cfg().poll * 1000;
      state.timer = setInterval(function () { ensureContainer(); bindOverlay(); poll(); }, ms);
    }

    // ---------- bootstrap ----------
    function boot() {
      if (state.booted) { ensureContainer(); bindOverlay(); render(); return; }
      state.booted = true;

      var sys = {};
      try { sys = self.system() || {}; } catch (e) { sys = {}; }
      state.uid = sys.user_id || (window.AMOCRM && AMOCRM.constant && AMOCRM.constant('user') && AMOCRM.constant('user').id) || null;
      state.sub = sys.subdomain || location.hostname.split('.')[0] || 'acc';
      state.base = (self.params && (self.params.cdn_path || self.params.path)) || '';

      loadState();
      injectCss();
      initAudio();
      primeOnGesture();
      askNotifyPermission();
      ensureContainer();
      bindOverlay();
      render();       // re-exibe as que ficaram de sessões anteriores
      poll();         // primeira checagem imediata
      startLoop();
    }

    // ---------- callbacks do Kommo ----------
    this.callbacks = {
      render: function () { return true; },
      init: function () {
        try { boot(); } catch (e) { if (window.console) console.error('[ruston-notify] init', e); }
        return true;
      },
      bind_actions: function () { return true; },
      settings: function () { return true; },
      onSave: function () { return true; },
      dpSettings: function () { return true; },
      destroy: function () {
        try { if (state.timer) clearInterval(state.timer); } catch (e) {}
        var c = document.getElementById(NS + '-root'); if (c) c.parentNode.removeChild(c);
      },
    };

    return this;
  };
  return CustomWidget;
});
