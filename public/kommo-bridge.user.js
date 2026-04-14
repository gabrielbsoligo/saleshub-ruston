// ==UserScript==
// @name         SalesHub Kommo Bridge
// @namespace    https://saleshub-ruston.vercel.app/
// @version      0.1.0
// @description  Extrai dados do Kommo (custom fields, notas, eventos) e envia pro SalesHub para auditoria de leads.
// @author       SalesHub Ruston
// @match        https://*.kommo.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://saleshub-ruston.vercel.app/kommo-bridge.user.js
// @downloadURL  https://saleshub-ruston.vercel.app/kommo-bridge.user.js
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.1.0';
  const DEFAULT_ENDPOINT = 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/audit-snapshot';
  const TOKEN_KEY = 'saleshub_bridge_token';
  const ENDPOINT_KEY = 'saleshub_bridge_endpoint';
  const DEBOUNCE_MS = 1500;
  const MIN_INTERVAL_MS = 5000; // mesmo lead, no minimo 5s entre envios

  // === Token / endpoint setup ===
  function getToken() {
    let t = localStorage.getItem(TOKEN_KEY);
    if (!t) {
      t = prompt('SalesHub Bridge: cole o token gerado no SalesHub (uma vez):');
      if (t && t.trim()) {
        localStorage.setItem(TOKEN_KEY, t.trim());
        return t.trim();
      }
      return null;
    }
    return t;
  }
  function getEndpoint() {
    return localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT;
  }

  // === Lead detection (Kommo SPA) ===
  function getCurrentLeadId() {
    const m = location.pathname.match(/\/leads\/detail\/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  function getSubdomain() {
    return location.hostname.split('.')[0];
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
      const res = await fetch(getEndpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bridge-token': token,
        },
        body: JSON.stringify({
          kommo_lead_id: leadId,
          kommo_account_subdomain: getSubdomain(),
          payload,
          bridge_version: VERSION,
          source,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        setBadge('error', `${res.status}: ${err.slice(0, 60)}`);
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
      if (confirm('Resetar token do SalesHub Bridge?')) {
        localStorage.removeItem(TOKEN_KEY);
        location.reload();
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
  let lastUrl = location.href;

  function onRouteMaybeChanged() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const id = getCurrentLeadId();
      if (id) sendSnapshot(id, 'auto');
    }, DEBOUNCE_MS);
  }

  // Hook history API
  const _push = history.pushState;
  history.pushState = function () { _push.apply(this, arguments); onRouteMaybeChanged(); };
  const _replace = history.replaceState;
  history.replaceState = function () { _replace.apply(this, arguments); onRouteMaybeChanged(); };
  window.addEventListener('popstate', onRouteMaybeChanged);

  // Polling fallback (Kommo as vezes nao chama pushState)
  setInterval(onRouteMaybeChanged, 1000);

  // === postMessage listener (SalesHub controla popup) ===
  window.addEventListener('message', (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    if (ev.data.source !== 'saleshub') return;
    if (ev.data.action === 'goto' && ev.data.kommoUrl) {
      try {
        const u = new URL(ev.data.kommoUrl);
        if (u.hostname.endsWith('.kommo.com')) {
          location.href = u.href;
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
    const id = getCurrentLeadId();
    if (id) sendSnapshot(id, 'auto');
    // Notify opener (SalesHub) that bridge is alive
    try {
      if (window.opener) {
        window.opener.postMessage({ source: 'kommo-bridge', type: 'ready', version: VERSION }, '*');
      }
    } catch { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Bookmarklet entrypoint: window.installKommoBridge() faz nada extra
  // (script ja inicializou ao ser executado). Funcao existe so pra simetria.
  window.installKommoBridge = function () { boot(); };
})();
