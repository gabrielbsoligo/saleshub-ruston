// ==UserScript==
// @name         SalesHub Kommo Bridge
// @namespace    https://gestao-comercial-rosy.vercel.app/
// @version      0.1.1
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

  const VERSION = '0.1.1';
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const DEFAULT_ENDPOINT = 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/audit-snapshot';
  const TOKEN_KEY = 'saleshub_bridge_token';
  const ENDPOINT_KEY = 'saleshub_bridge_endpoint';
  const DEBOUNCE_MS = 1500;
  const MIN_INTERVAL_MS = 5000; // mesmo lead, no minimo 5s entre envios

  // === Token / endpoint setup (GM storage = persiste mesmo se Kommo limpar localStorage) ===
  function getToken() {
    let t = (typeof GM_getValue === 'function' ? GM_getValue(TOKEN_KEY, '') : '') || '';
    if (!t) {
      t = win.prompt('SalesHub Bridge: cole o token gerado no SalesHub (uma vez):');
      if (t && t.trim()) {
        t = t.trim();
        if (typeof GM_setValue === 'function') GM_setValue(TOKEN_KEY, t);
        return t;
      }
      return null;
    }
    return t;
  }
  function getEndpoint() {
    return (typeof GM_getValue === 'function' ? GM_getValue(ENDPOINT_KEY, '') : '') || DEFAULT_ENDPOINT;
  }

  // === Lead detection (Kommo SPA) ===
  function getCurrentLeadId() {
    const m = win.location.pathname.match(/\/leads\/detail\/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  function getSubdomain() {
    return win.location.hostname.split('.')[0];
  }

  // === DOM extractors (best-effort, defensivo) ===
  function safeText(el) {
    return el ? (el.innerText || el.textContent || '').trim() : '';
  }

  function extractLeadHeader() {
    // Nome do lead, status, responsavel
    const nameEl = document.querySelector('.card-top__title, [data-id="lead-name"], h2.element-pipeline-name__title');
    const statusEl = document.querySelector('.pipeline_select__control_value, .button-input-text');
    const respEl = document.querySelector('.responsible-user__name, [data-element="responsible-user"]');
    return {
      name: safeText(nameEl),
      status_label: safeText(statusEl),
      responsible_label: safeText(respEl),
    };
  }

  function extractCustomFields() {
    // Custom fields aparecem em .linked-form__field ou .custom_fields ou similar
    const fields = [];
    const nodes = document.querySelectorAll(
      '.linked-form__field, .card-cf-row, .custom_field, [data-id^="cfv"]'
    );
    nodes.forEach((node) => {
      const labelEl = node.querySelector('.linked-form__field__label, .card-cf-name, .custom_field__name, label');
      const valueEl = node.querySelector('.linked-form__field__value, .card-cf-value, .custom_field__value, input, textarea, .control-text');
      const label = safeText(labelEl);
      let value = '';
      if (valueEl) {
        if (valueEl.tagName === 'INPUT' || valueEl.tagName === 'TEXTAREA') {
          value = valueEl.value || '';
        } else {
          value = safeText(valueEl);
        }
      }
      if (label) fields.push({ label, value });
    });
    return fields;
  }

  function extractNotes() {
    // Notas no feed lateral
    const notes = [];
    const items = document.querySelectorAll('.feed-note, .feed-compose-text, [data-id^="note"]');
    items.forEach((it) => {
      const text = safeText(it.querySelector('.feed-note-wrapper__text, .feed-note__body, .text'));
      const author = safeText(it.querySelector('.feed-note__author, .feed-note-wrapper__author'));
      const time = safeText(it.querySelector('.feed-note__date, time'));
      if (text) notes.push({ author, time, text });
    });
    return notes;
  }

  function extractContacts() {
    const contacts = [];
    const items = document.querySelectorAll('.linked-card, .linked-contact, .contact-card');
    items.forEach((it) => {
      const name = safeText(it.querySelector('.linked-card__name, .contact-name, a'));
      if (name) contacts.push({ name });
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
      whatsapp_messages: [], // v0.2
      events_summary: [],
      extracted_at: new Date().toISOString(),
    };
  }

  // === Sender ===
  let lastSent = new Map(); // leadId -> timestamp
  let inflight = false;

  async function sendSnapshot(leadId, source = 'auto') {
    if (inflight) return;
    const now = Date.now();
    const last = lastSent.get(leadId) || 0;
    if (source === 'auto' && now - last < MIN_INTERVAL_MS) return;

    const token = getToken();
    if (!token) {
      setBadge('error', 'sem token');
      return;
    }

    inflight = true;
    setBadge('working', `enviando ${leadId}…`);
    try {
      const payload = buildPayload(leadId);
      const body = JSON.stringify({
        kommo_lead_id: leadId,
        kommo_account_subdomain: getSubdomain(),
        payload,
        bridge_version: VERSION,
        source,
      });

      // Usa GM_xmlhttpRequest pra contornar CORS/CSP
      const result = await new Promise((resolve) => {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'POST',
            url: getEndpoint(),
            headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
            data: body,
            onload: (r) => resolve({ status: r.status, text: r.responseText }),
            onerror: (e) => resolve({ status: 0, text: String(e) }),
          });
        } else {
          // Fallback fetch
          fetch(getEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-token': token }, body })
            .then(async r => resolve({ status: r.status, text: await r.text() }))
            .catch(e => resolve({ status: 0, text: String(e) }));
        }
      });

      if (result.status < 200 || result.status >= 300) {
        setBadge('error', `${result.status}: ${(result.text || '').slice(0, 60)}`);
        return;
      }
      lastSent.set(leadId, now);
      setBadge('ok', `lead ${leadId} ✓`);
    } catch (e) {
      setBadge('error', String(e).slice(0, 60));
    } finally {
      inflight = false;
    }
  }

  // === Badge UI ===
  let badgeEl;
  function setupBadge() {
    if (badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.id = 'saleshub-bridge-badge';
    Object.assign(badgeEl.style, {
      position: 'fixed', bottom: '12px', right: '12px',
      zIndex: '99999', padding: '6px 10px',
      borderRadius: '6px', fontFamily: 'system-ui, sans-serif',
      fontSize: '12px', color: '#fff', background: '#666',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)', cursor: 'pointer',
      maxWidth: '320px',
    });
    badgeEl.title = 'SalesHub Bridge — clique para forcar reenvio';
    badgeEl.addEventListener('click', () => {
      const id = getCurrentLeadId();
      if (id) sendSnapshot(id, 'manual_command');
    });
    badgeEl.addEventListener('dblclick', () => {
      if (win.confirm('Resetar token do SalesHub Bridge?')) {
        if (typeof GM_setValue === 'function') GM_setValue(TOKEN_KEY, '');
        win.location.reload();
      }
    });
    document.body.appendChild(badgeEl);
    setBadge('idle', `v${VERSION}`);
  }
  function setBadge(state, text) {
    if (!badgeEl) return;
    const colors = { idle: '#666', working: '#1d4ed8', ok: '#16a34a', error: '#dc2626' };
    badgeEl.style.background = colors[state] || '#666';
    badgeEl.textContent = `🔗 SalesHub ${state} — ${text}`;
  }

  // === SPA route observer ===
  let debounceTimer = null;
  let lastUrl = win.location.href;

  function onRouteMaybeChanged() {
    if (win.location.href === lastUrl) return;
    lastUrl = win.location.href;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const id = getCurrentLeadId();
      if (id) sendSnapshot(id, 'auto');
    }, DEBOUNCE_MS);
  }

  // Hook history API (na window REAL da pagina)
  try {
    const _push = win.history.pushState;
    win.history.pushState = function () { _push.apply(this, arguments); onRouteMaybeChanged(); };
    const _replace = win.history.replaceState;
    win.history.replaceState = function () { _replace.apply(this, arguments); onRouteMaybeChanged(); };
  } catch (e) { /* CSP pode bloquear, polling assume */ }
  win.addEventListener('popstate', onRouteMaybeChanged);

  // Polling fallback (Kommo as vezes nao chama pushState, ou hook foi bloqueado)
  setInterval(onRouteMaybeChanged, 1000);

  // === postMessage listener (SalesHub controla popup) ===
  win.addEventListener('message', (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    if (ev.data.source !== 'saleshub') return;
    if (ev.data.action === 'goto' && ev.data.kommoUrl) {
      try {
        const u = new URL(ev.data.kommoUrl);
        if (u.hostname.endsWith('.kommo.com')) {
          win.location.href = u.href;
        }
      } catch { /* ignore */ }
    }
    if (ev.data.action === 'extract') {
      const id = getCurrentLeadId();
      if (id) sendSnapshot(id, 'manual_command');
    }
  });

  // === Boot ===
  function boot() {
    setupBadge();
    console.log('[SalesHub Bridge] boot v' + VERSION + ' on ' + win.location.href);
    const id = getCurrentLeadId();
    if (id) sendSnapshot(id, 'auto');
    // Notify opener (SalesHub) that bridge is alive
    try {
      if (win.opener) {
        win.opener.postMessage({ source: 'kommo-bridge', type: 'ready', version: VERSION }, '*');
      }
    } catch { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Bookmarklet entrypoint
  win.installKommoBridge = function () { boot(); };
})();
