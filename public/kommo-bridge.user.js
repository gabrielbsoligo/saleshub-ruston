// ==UserScript==
// @name         SalesHub Kommo Bridge
// @namespace    https://gestao-comercial-rosy.vercel.app/
// @version      0.1.4
// @description  Extrai dados do Kommo (custom fields, notas, eventos) e envia pro SalesHub para auditoria de leads.
// @author       SalesHub Ruston
// @match        https://*.kommo.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      iaompeiokjxbffwehhrx.supabase.co
// @run-at       document-idle
// @updateURL    https://gestao-comercial-rosy.vercel.app/kommo-bridge.user.js
// @downloadURL  https://gestao-comercial-rosy.vercel.app/kommo-bridge.user.js
// ==/UserScript==

/* global GM_setValue, GM_getValue, GM_xmlhttpRequest, unsafeWindow */

(function () {
  'use strict';

  var VERSION = '0.1.4';
  var win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  var DEFAULT_ENDPOINT = 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/audit-snapshot';
  var TOKEN_KEY = 'saleshub_bridge_token';
  var ENDPOINT_KEY = 'saleshub_bridge_endpoint';
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
    if (!token) {
      setBadge('error', 'sem token');
      return;
    }

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
        method: 'POST',
        url: getEndpoint(),
        headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
        data: body,
        onload: function (r) { onDone(r.status, r.responseText); },
        onerror: function (e) { onDone(0, String(e)); },
      });
    } catch (_e) {
      // Fallback fetch
      fetch(getEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
        body: body,
      })
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
    badgeEl.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99999;padding:6px 10px;border-radius:6px;font-family:system-ui,sans-serif;font-size:12px;color:#fff;background:#666;box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;max-width:320px;';
    badgeEl.title = 'SalesHub Bridge — clique para forcar reenvio';
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
    win.console.log('[SalesHub Bridge] badge criado');
  }
  function setBadge(state, text) {
    if (!badgeEl) return;
    var colors = { idle: '#666', working: '#1d4ed8', ok: '#16a34a', error: '#dc2626' };
    badgeEl.style.background = colors[state] || '#666';
    badgeEl.textContent = 'SalesHub ' + state + ' — ' + text;
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
      if (id) sendSnapshot(id, 'auto');
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
    if (ev.data.source !== 'saleshub') return;
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
  });

  // === Boot ===
  function boot() {
    setupBadge();
    win.console.log('[SalesHub Bridge] boot v' + VERSION + ' on ' + win.location.href);
    var id = getCurrentLeadId();
    if (id) sendSnapshot(id, 'auto');
    try {
      if (win.opener) {
        win.opener.postMessage({ source: 'kommo-bridge', type: 'ready', version: VERSION }, '*');
      }
    } catch (_e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  win.installKommoBridge = function () { boot(); };
})();
