// ==UserScript==
// @name         SalesHub Kommo Bridge
// @namespace    https://gestao-comercial-rosy.vercel.app/
// @version      0.2.4
// @description  Extrai dados do Kommo e injeta painel de auditoria SalesHub.
// @author       SalesHub Ruston
// @match        https://*.kommo.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      iaompeiokjxbffwehhrx.supabase.co
// @connect      gestao-comercial-rosy.vercel.app
// @run-at       document-idle
// @updateURL    https://gestao-comercial-rosy.vercel.app/kommo-bridge.user.js
// @downloadURL  https://gestao-comercial-rosy.vercel.app/kommo-bridge.user.js
// ==/UserScript==

/* global GM_setValue, GM_getValue, GM_xmlhttpRequest, unsafeWindow */

(function () {
  'use strict';

  var VERSION = '0.2.4';
  var win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  var SALESHUB_ORIGIN = 'https://gestao-comercial-rosy.vercel.app';
  var DEFAULT_ENDPOINT = 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/audit-snapshot';
  var TOKEN_KEY = 'saleshub_bridge_token';
  var ENDPOINT_KEY = 'saleshub_bridge_endpoint';
  var AUDIT_SESSION_KEY = 'saleshub_audit_session';
  var DEBOUNCE_MS = 1500;
  var MIN_INTERVAL_MS = 5000;

  // === Token / endpoint setup ===
  function getToken() {
    var t = '';
    try { t = GM_getValue(TOKEN_KEY, '') || ''; } catch (_e) { t = ''; }
    if (!t) {
      t = win.prompt('SalesHub Bridge: cole o token gerado no SalesHub (uma vez):');
      if (t && t.trim()) {
        t = t.trim();
        try { GM_setValue(TOKEN_KEY, t); } catch (_e) { /* noop */ }
        return t;
      }
      return null;
    }
    return t;
  }
  function getEndpoint() {
    var ep = '';
    try { ep = GM_getValue(ENDPOINT_KEY, '') || ''; } catch (_e) { ep = ''; }
    return ep || DEFAULT_ENDPOINT;
  }

  // === Lead detection ===
  function getCurrentLeadId() {
    var m = win.location.pathname.match(/\/leads\/detail\/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  function getSubdomain() {
    return win.location.hostname.split('.')[0];
  }

  // === DOM extractors ===
  function safeText(el) {
    return el ? (el.innerText || el.textContent || '').trim() : '';
  }

  function extractLeadHeader() {
    var nameEl = document.querySelector('.card-top__title, [data-id="lead-name"], h2.element-pipeline-name__title');
    var statusEl = document.querySelector('.pipeline_select__control_value, .button-input-text');
    var respEl = document.querySelector('.responsible-user__name, [data-element="responsible-user"]');
    return {
      name: safeText(nameEl),
      status_label: safeText(statusEl),
      responsible_label: safeText(respEl),
    };
  }

  function extractCustomFields() {
    var fields = [];
    var nodes = document.querySelectorAll(
      '.linked-form__field, .card-cf-row, .custom_field, [data-id^="cfv"]'
    );
    nodes.forEach(function (node) {
      var labelEl = node.querySelector('.linked-form__field__label, .card-cf-name, .custom_field__name, label');
      var valueEl = node.querySelector('.linked-form__field__value, .card-cf-value, .custom_field__value, input, textarea, .control-text');
      var label = safeText(labelEl);
      var value = '';
      if (valueEl) {
        if (valueEl.tagName === 'INPUT' || valueEl.tagName === 'TEXTAREA') {
          value = valueEl.value || '';
        } else {
          value = safeText(valueEl);
        }
      }
      if (label) fields.push({ label: label, value: value });
    });
    return fields;
  }

  function extractNotes() {
    var notes = [];
    var items = document.querySelectorAll('.feed-note, .feed-compose-text, [data-id^="note"]');
    items.forEach(function (it) {
      var text = safeText(it.querySelector('.feed-note-wrapper__text, .feed-note__body, .text'));
      var author = safeText(it.querySelector('.feed-note__author, .feed-note-wrapper__author'));
      var time = safeText(it.querySelector('.feed-note__date, time'));
      if (text) notes.push({ author: author, time: time, text: text });
    });
    return notes;
  }

  function extractContacts() {
    var contacts = [];
    var items = document.querySelectorAll('.linked-card, .linked-contact, .contact-card');
    items.forEach(function (it) {
      var name = safeText(it.querySelector('.linked-card__name, .contact-name, a'));
      if (name) contacts.push({ name: name });
    });
    return contacts;
  }

  function buildPayload(leadId) {
    return {
      lead_id: leadId,
      url: location.href,
      header: extractLeadHeader(),
      custom_fields: extractCustomFields(),
      notes: extractNotes(),
      contacts: extractContacts(),
      whatsapp_messages: [],
      events_summary: [],
      extracted_at: new Date().toISOString(),
    };
  }

  // === Sender ===
  var lastSent = {};
  var inflight = false;

  function sendSnapshot(leadId, source) {
    if (inflight) return;
    source = source || 'auto';
    var now = Date.now();
    var last = lastSent[leadId] || 0;
    if (source === 'auto' && now - last < MIN_INTERVAL_MS) return;

    var token = getToken();
    if (!token) { setBadge('error', 'sem token'); return; }

    inflight = true;
    setBadge('working', 'enviando ' + leadId + '...');

    var payload = buildPayload(leadId);
    var body = JSON.stringify({
      kommo_lead_id: leadId,
      kommo_account_subdomain: getSubdomain(),
      payload: payload,
      bridge_version: VERSION,
      source: source,
    });

    function onDone(status, text) {
      inflight = false;
      if (status >= 200 && status < 300) {
        lastSent[leadId] = Date.now();
        setBadge('ok', 'lead ' + leadId + ' ok');
      } else {
        setBadge('error', status + ': ' + (text || '').slice(0, 60));
      }
    }

    try {
      GM_xmlhttpRequest({
        method: 'POST', url: getEndpoint(),
        headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
        data: body,
        onload: function (r) { onDone(r.status, r.responseText); },
        onerror: function (e) { onDone(0, String(e)); },
      });
    } catch (_e) {
      fetch(getEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-token': token }, body: body })
        .then(function (r) { return r.text().then(function (t) { onDone(r.status, t); }); })
        .catch(function (e) { onDone(0, String(e)); });
    }
  }

  // === Badge UI ===
  var badgeEl = null;
  function setupBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.id = 'saleshub-bridge-badge';
    badgeEl.style.cssText = 'position:fixed;bottom:12px;z-index:99999;padding:6px 10px;border-radius:6px;font-family:system-ui,sans-serif;font-size:12px;color:#fff;background:#666;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;max-width:320px;transition:right 0.3s;right:12px;';
    badgeEl.title = 'SalesHub Bridge';
    badgeEl.addEventListener('click', function () {
      var id = getCurrentLeadId();
      if (id) sendSnapshot(id, 'manual_command');
    });
    badgeEl.addEventListener('dblclick', function () {
      if (win.confirm('Resetar token do SalesHub Bridge?')) {
        try { GM_setValue(TOKEN_KEY, ''); } catch (_e) { /* noop */ }
        win.location.reload();
      }
    });
    document.body.appendChild(badgeEl);
    setBadge('idle', 'v' + VERSION);
  }
  function setBadge(state, text) {
    if (!badgeEl) return;
    var colors = { idle: '#666', working: '#1d4ed8', ok: '#16a34a', error: '#dc2626' };
    badgeEl.style.background = colors[state] || '#666';
    badgeEl.textContent = 'SalesHub ' + state + ' — ' + text;
  }

  // =============================================
  // AUDIT SIDEBAR — iframe do SalesHub
  // =============================================
  var sidebarEl = null;
  var sidebarIframe = null;
  var currentSidebarSessionId = null;
  var SIDEBAR_WIDTH = 380;

  function persistAuditSession(sessionId, accessToken, refreshToken) {
    try {
      GM_setValue(AUDIT_SESSION_KEY, JSON.stringify({
        sessionId: sessionId,
        accessToken: accessToken,
        refreshToken: refreshToken,
        ts: Date.now(),
      }));
    } catch (_e) { /* noop */ }
  }

  function clearPersistedAuditSession() {
    try { GM_setValue(AUDIT_SESSION_KEY, ''); } catch (_e) { /* noop */ }
  }

  function getPersistedAuditSession() {
    try {
      var raw = GM_getValue(AUDIT_SESSION_KEY, '');
      if (!raw) return null;
      var obj = JSON.parse(raw);
      // Expira depois de 4h
      if (Date.now() - (obj.ts || 0) > 4 * 60 * 60 * 1000) {
        clearPersistedAuditSession();
        return null;
      }
      return obj;
    } catch (_e) { return null; }
  }

  function openAuditSidebar(sessionId, accessToken, refreshToken) {
    // Se já existe sidebar para esta sessão, não recria — apenas envia ack
    if (sidebarEl && currentSidebarSessionId === sessionId) {
      win.console.log('[SalesHub Bridge] sidebar already open for session=' + sessionId + ', skipping');
      sendAck();
      return;
    }
    if (sidebarEl) { closeAuditSidebar(); }

    // Persistir sessão para sobreviver a navegações/reloads
    persistAuditSession(sessionId, accessToken, refreshToken);

    // Container
    sidebarEl = document.createElement('div');
    sidebarEl.id = 'saleshub-audit-sidebar';
    sidebarEl.style.cssText = 'position:fixed;top:0;right:0;width:' + SIDEBAR_WIDTH + 'px;height:100vh;z-index:99998;box-shadow:-4px 0 20px rgba(0,0,0,0.4);transition:transform 0.3s;transform:translateX(0);';

    // Iframe — pass tokens via hash (not query, to avoid server logs)
    sidebarIframe = document.createElement('iframe');
    var hashParts = 'at=' + encodeURIComponent(accessToken || '') + '&rt=' + encodeURIComponent(refreshToken || '');
    var url = SALESHUB_ORIGIN + '/?audit_panel=1&session=' + sessionId + '#' + hashParts;
    sidebarIframe.src = url;
    sidebarIframe.style.cssText = 'width:100%;height:100%;border:none;';
    sidebarIframe.setAttribute('allow', 'clipboard-write');
    sidebarEl.appendChild(sidebarIframe);

    document.body.appendChild(sidebarEl);

    // Empurrar badge pra esquerda do sidebar
    if (badgeEl) badgeEl.style.right = (SIDEBAR_WIDTH + 12) + 'px';

    currentSidebarSessionId = sessionId;
    win.console.log('[SalesHub Bridge] audit sidebar opened, session=' + sessionId + ', hasToken=' + !!accessToken);
    sendAck();
  }

  function sendAck() {
    try {
      if (win.opener) {
        win.opener.postMessage({ source: 'kommo-bridge', type: 'sidebar-ack' }, '*');
      }
    } catch (_e) { /* ignore */ }
  }

  function closeAuditSidebar(clearPersistence) {
    if (sidebarEl) {
      sidebarEl.remove();
      sidebarEl = null;
      sidebarIframe = null;
      currentSidebarSessionId = null;
    }
    if (clearPersistence) {
      clearPersistedAuditSession();
    }
    if (badgeEl) badgeEl.style.right = '12px';
    win.console.log('[SalesHub Bridge] audit sidebar closed' + (clearPersistence ? ' (session ended)' : ''));
  }

  // Notifica o iframe quando navegar pra um novo lead
  function notifyIframeLeadChanged(leadId) {
    if (sidebarIframe && sidebarIframe.contentWindow) {
      sidebarIframe.contentWindow.postMessage({
        source: 'kommo-bridge',
        type: 'lead-changed',
        kommoLeadId: leadId,
        url: win.location.href,
      }, SALESHUB_ORIGIN);
    }
  }

  // === SPA route observer ===
  var debounceTimer = null;
  var lastUrl = win.location.href;

  function onRouteMaybeChanged() {
    if (win.location.href === lastUrl) return;
    lastUrl = win.location.href;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      var id = getCurrentLeadId();
      if (id) {
        sendSnapshot(id, 'auto');
        notifyIframeLeadChanged(id);
      }
    }, DEBOUNCE_MS);
  }

  try {
    var _push = win.history.pushState;
    win.history.pushState = function () { _push.apply(this, arguments); onRouteMaybeChanged(); };
    var _replace = win.history.replaceState;
    win.history.replaceState = function () { _replace.apply(this, arguments); onRouteMaybeChanged(); };
  } catch (_e) { /* CSP pode bloquear */ }
  win.addEventListener('popstate', onRouteMaybeChanged);
  setInterval(onRouteMaybeChanged, 1000);

  // === postMessage listener ===
  win.addEventListener('message', function (ev) {
    if (!ev.data || typeof ev.data !== 'object') return;

    // Mensagens do SalesHub (da pagina principal ou do iframe)
    if (ev.data.source === 'saleshub') {
      if (ev.data.action === 'goto' && ev.data.kommoUrl) {
        try {
          var u = new URL(ev.data.kommoUrl);
          if (u.hostname.endsWith('.kommo.com')) {
            win.location.href = u.href;
          }
        } catch (_e) { /* ignore */ }
      }
      if (ev.data.action === 'extract') {
        var id = getCurrentLeadId();
        if (id) sendSnapshot(id, 'manual_command');
      }
      // Abrir sidebar de auditoria (com tokens de auth)
      if (ev.data.action === 'start-audit' && ev.data.sessionId) {
        openAuditSidebar(ev.data.sessionId, ev.data.accessToken, ev.data.refreshToken);
      }
      // Fechar sidebar (usuario encerrou)
      if (ev.data.action === 'stop-audit') {
        closeAuditSidebar(true);
      }
    }

    // Mensagens do iframe audit-panel
    if (ev.data.source === 'saleshub-audit-panel') {
      if ((ev.data.action === 'navigate' || ev.data.action === 'check-url-then-navigate') && ev.data.kommoUrl) {
        try {
          var u2 = new URL(ev.data.kommoUrl);
          if (u2.hostname.endsWith('.kommo.com')) {
            // Só navega se a URL atual for diferente (evita loop de reload)
            var currentPath = win.location.pathname;
            var targetPath = u2.pathname;
            if (currentPath !== targetPath) {
              win.console.log('[SalesHub Bridge] navigating from ' + currentPath + ' to ' + targetPath);
              win.location.href = u2.href;
            } else {
              win.console.log('[SalesHub Bridge] already on ' + targetPath + ', skipping navigation');
            }
          }
        } catch (_e) { /* ignore */ }
      }
      if (ev.data.action === 'close') {
        closeAuditSidebar(true);
      }
      if (ev.data.action === 'extract') {
        var id2 = getCurrentLeadId();
        if (id2) sendSnapshot(id2, 'manual_command');
      }
    }
  });

  // === Boot ===
  function boot() {
    setupBadge();
    win.console.log('[SalesHub Bridge] boot v' + VERSION + ' on ' + win.location.href);
    var id = getCurrentLeadId();
    if (id) sendSnapshot(id, 'auto');
    // Notify opener
    try {
      if (win.opener) {
        win.opener.postMessage({ source: 'kommo-bridge', type: 'ready', version: VERSION }, '*');
      }
    } catch (_e) { /* ignore */ }

    // Restaurar sidebar se havia sessão de auditoria ativa (sobrevive a navegação/reload)
    var persisted = getPersistedAuditSession();
    if (persisted && persisted.sessionId) {
      win.console.log('[SalesHub Bridge] restoring audit sidebar for session=' + persisted.sessionId);
      openAuditSidebar(persisted.sessionId, persisted.accessToken, persisted.refreshToken);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  win.installKommoBridge = function () { boot(); };
})();
