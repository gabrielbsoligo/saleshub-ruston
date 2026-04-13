// ============================================================
// MKTLAB → SalesHub Batch Importer v1.0
// Bookmarklet: roda na pagina do mktlab.app/crm/leads
// Injeta side panel com UI pra importar leads em lote
// ============================================================
(function() {
  'use strict';

  // ---- Config ----
  var SUPABASE_URL = 'https://iaompeiokjxbffwehhrx.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMjI5MDIsImV4cCI6MjA5MDc5ODkwMn0.D-rf7H8F21LyslQxmr6AGM13kWTWs7f05OcnBt5kbxg';
  var SALESHUB_URL = 'https://gestao-comercial-rosy.vercel.app';

  // Prevent double-injection
  if (document.getElementById('sh-importer-panel')) {
    document.getElementById('sh-importer-panel').remove();
  }

  // ---- State ----
  var supabaseSession = null;
  var currentUser = null;
  var teamMembers = [];
  var detectedColumns = [];
  var fetchedLeads = [];
  var enrichedLeads = [];
  var selectedIds = {};

  // ---- Supabase helpers ----
  function supaFetch(path, opts) {
    opts = opts || {};
    var headers = {
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    };
    if (supabaseSession && supabaseSession.access_token) {
      headers['Authorization'] = 'Bearer ' + supabaseSession.access_token;
    }
    Object.assign(headers, opts.headers || {});
    return fetch(SUPABASE_URL + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body || undefined,
    }).then(function(res) {
      if (!res.ok) return res.json().then(function(b) { throw new Error(b.message || b.error_description || 'HTTP ' + res.status); });
      return res.json();
    });
  }

  // ---- MKTLAB API (uses page cookies) ----
  function mktFetch(url) {
    return fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/plain, */*' },
      credentials: 'include',
    }).then(function(res) {
      if (res.status === 401) throw new Error('Sessao MKTLAB expirada! Recarregue a pagina.');
      if (!res.ok) throw new Error('Erro ' + res.status);
      return res.json();
    });
  }

  // ---- Extract columns from DOM ----
  function extractColumns() {
    var columns = [];
    var main = document.querySelector('main');
    if (!main) return columns;

    // Find heading elements + lead counts + first lead link
    var headings = main.querySelectorAll('h2, h3, [role="heading"]');
    headings.forEach(function(h) {
      var name = h.textContent.trim();
      if (!name || /^\d+\s*leads?$/i.test(name)) return;

      // Find the parent column container
      var container = h.closest('[class]');
      if (!container) container = h.parentElement;

      // Walk up to find a broader container that includes lead links
      var searchEl = container;
      for (var i = 0; i < 5; i++) {
        if (!searchEl || !searchEl.parentElement) break;
        var links = searchEl.querySelectorAll('a[href*="/crm/leads/"]');
        if (links.length > 0) break;
        searchEl = searchEl.parentElement;
      }

      // Find count "X leads"
      var total = 0;
      var allText = searchEl ? searchEl.querySelectorAll('*') : [];
      for (var j = 0; j < allText.length; j++) {
        var t = allText[j].textContent.trim();
        var m = t.match(/^(\d+)\s*leads?$/i);
        if (m) { total = parseInt(m[1]); break; }
      }

      // Find first lead link
      var firstLeadId = null;
      if (searchEl) {
        var leadLinks = searchEl.querySelectorAll('a[href*="/crm/leads/"]');
        if (leadLinks.length > 0) {
          var href = leadLinks[0].getAttribute('href') || '';
          var lm = href.match(/\/crm\/leads\/([a-f0-9-]+)/);
          if (lm) firstLeadId = lm[1];
        }
      }

      // Avoid duplicates
      if (!columns.find(function(c) { return c.name === name; })) {
        columns.push({ name: name, total: total, firstLeadId: firstLeadId, columnId: null });
      }
    });

    return columns;
  }

  // Resolve columnIds by fetching one lead per column
  function resolveColumnIds(columns) {
    var promises = columns.map(function(col) {
      if (!col.firstLeadId) return Promise.resolve();
      return mktFetch('https://mktlab.app/crm/api/leads/' + col.firstLeadId + '/basic-data')
        .then(function(data) {
          if (data && data.columnId) col.columnId = data.columnId;
        })
        .catch(function() { /* skip */ });
    });
    return Promise.all(promises).then(function() { return columns; });
  }

  // ---- Fetch leads from column (paginated) ----
  function fetchAllLeads(columnId) {
    var allLeads = [];
    var page = 1;

    function fetchPage() {
      var url = 'https://mktlab.app/crm/api/leads/list?page=' + page + '&limit=50&columnId=' + columnId + '&personalizedFilterId=';
      return mktFetch(url).then(function(data) {
        var cards = data.cards || [];
        if (cards.length === 0) return allLeads;
        allLeads = allLeads.concat(cards);
        if (!data.hasMore || (data.totalPages && page >= data.totalPages)) return allLeads;
        page++;
        return new Promise(function(r) { setTimeout(r, 300); }).then(fetchPage);
      });
    }

    return fetchPage();
  }

  // ---- Fetch lead detail ----
  function fetchLeadDetail(leadId) {
    var result = { basicData: {}, customFields: {} };
    return mktFetch('https://mktlab.app/crm/api/leads/' + leadId + '/basic-data')
      .then(function(d) { result.basicData = d; })
      .catch(function() {})
      .then(function() { return new Promise(function(r) { setTimeout(r, 150); }); })
      .then(function() {
        return mktFetch('https://mktlab.app/crm/api/leads/' + leadId + '/custom-fields-categories');
      })
      .then(function(d) { result.customFields = parseCustomFields(d); })
      .catch(function() {})
      .then(function() { return result; });
  }

  function parseCustomFields(categoriesData) {
    var result = {};
    var categories = categoriesData.categories || categoriesData;
    if (!Array.isArray(categories)) return result;
    categories.forEach(function(cat) {
      if (!cat.items) return;
      cat.items.forEach(function(item) {
        var value = '';
        if (item.answer && item.answer.length > 0) value = item.answer.join('; ');
        if (!value && item.answerMultiChoice && item.answerMultiChoice.length > 0) {
          var sel = item.answerMultiChoice.filter(function(o) { return o.isSelected; }).map(function(o) { return o.value; });
          if (sel.length > 0) value = sel.join('; ');
        }
        result[item.title] = value;
        // Also store by normalized key (strip accents/special chars) for resilient matching
        var normKey = item.title.normalize('NFC').replace(/[^\w\s]/g, '').toLowerCase().trim();
        if (!result['_norm_' + normKey]) result['_norm_' + normKey] = value;
      });
    });
    return result;
  }

  function findFieldByValue(customFields, pattern) {
    var keys = Object.keys(customFields);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('_norm_') === 0) continue;
      var v = customFields[keys[i]];
      if (v && pattern.test(v)) return v;
    }
    return null;
  }

  // ============================================================
  // normalizeLead / validatePayload — Shape B (transformer with metadata)
  // RFC: gabrielbsoligo/saleshub-ruston#5
  // ============================================================

  var VALID_CANAIS = ['blackbox', 'leadbroker', 'outbound', 'indicacao', 'recomendacao', 'recovery'];

  function mapCanalFromText(raw) {
    var s = String(raw || '').toLowerCase();
    if (!s) return null;
    if (s.indexOf('black') >= 0) return 'blackbox';
    if (s.indexOf('lead') >= 0) return 'leadbroker';
    if (s.indexOf('out') >= 0) return 'outbound';
    if (s.indexOf('recom') >= 0) return 'recomendacao';
    if (s.indexOf('indic') >= 0) return 'indicacao';
    if (s.indexOf('recov') >= 0) return 'recovery';
    return null;
  }

  // Detect canal from MKTLAB data. Returns { canal, source, raw }.
  // source: 'basic_data' | 'custom_field' | 'column_name' | 'fallback_dropdown'
  function detectCanal(rawLead, detail, fallbackDropdown) {
    var cf = (detail && detail.customFields) || {};
    var bd = (detail && detail.basicData) || {};

    // 1) basicData.acquisitionChannel.title — fonte estruturada (UI do MKTLAB)
    var bdText = (bd.acquisitionChannel && bd.acquisitionChannel.title) || '';
    var m = mapCanalFromText(bdText);
    if (m) return { canal: m, source: 'basic_data', raw: bdText };

    // 2) custom fields conhecidos
    var cfCandidates = [
      cf['Canal de Aquisição'], cf['Canal de aquisição'],
      cf['_norm_canal de aquisicao'], cf['_norm_canal de aquisio'],
      cf['Status Leadbroker'], cf['_norm_status leadbroker'],
    ];
    for (var i = 0; i < cfCandidates.length; i++) {
      m = mapCanalFromText(cfCandidates[i]);
      if (m) return { canal: m, source: 'custom_field', raw: cfCandidates[i] };
    }

    // 3) column name do board MKTLAB
    var col = (rawLead && rawLead.columnName) || '';
    m = mapCanalFromText(col);
    if (m) return { canal: m, source: 'column_name', raw: col };

    // 4) fallback: dropdown selecionado na UI
    var drop = mapCanalFromText(fallbackDropdown) || fallbackDropdown || null;
    return { canal: drop, source: 'fallback_dropdown', raw: fallbackDropdown || '' };
  }

  // Returns ISO date 'YYYY-MM-DD' or null.
  function toIsoDate(v) {
    if (!v) return null;
    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  }

  function detectDataCadastro(rawLead, detail) {
    var bd = (detail && detail.basicData) || {};
    // 1) data específica de aquisição se existir
    var d = toIsoDate(bd.acquisitionDate || bd.acquiredAt);
    if (d) return { data_cadastro: d, source: 'basic_data' };
    // 2) última movimentação da coluna (mais próximo do "recebi hoje")
    d = toIsoDate(rawLead && rawLead.columnUpdatedAt);
    if (d) return { data_cadastro: d, source: 'column_updated_at' };
    // 3) createdAt do lead
    d = toIsoDate(rawLead && rawLead.createdAt);
    if (d) return { data_cadastro: d, source: 'created_at' };
    return { data_cadastro: null, source: 'none' };
  }

  // Pure transformer: (rawLead from list, detail from /basic-data+/custom-fields, fallbackDropdown)
  // -> { payload, canalSource, canalRaw, dateSource, warnings }
  function normalizeLead(rawLead, detail, fallbackDropdown) {
    rawLead = rawLead || {};
    detail = detail || { basicData: {}, customFields: {} };
    var cf = detail.customFields || {};
    var bd = detail.basicData || {};

    var c = detectCanal(rawLead, detail, fallbackDropdown);
    var dc = detectDataCadastro(rawLead, detail);

    var warnings = [];
    if (c.source === 'fallback_dropdown') warnings.push('canal por fallback do dropdown');
    if (!c.canal) warnings.push('canal não detectado');
    if (!dc.data_cadastro) warnings.push('data_cadastro ausente');
    if (dc.source === 'created_at') warnings.push('data_cadastro usou createdAt (fallback)');

    var payload = {
      empresa: (rawLead.companyName || rawLead.title || bd.companyName || '').trim() || null,
      nome_contato: rawLead.title || bd.contactName || null,
      telefone: rawLead.phone || bd.phone || null,
      email: rawLead.email || bd.email || null,
      cnpj: rawLead.taxId || bd.taxId || null,
      faturamento: cf['Faturamento da LP'] || cf['Faturamento'] ||
                   cf['_norm_faturamento da lp'] || findFieldByValue(cf, /mil|milh/i) || null,
      produto: cf['Produtos Marketing'] || cf['Produto'] ||
               cf['_norm_produtos marketing'] || null,
      canal: c.canal,
      status: 'sem_contato',
      valor_lead: parseFloat(cf['Valor Leadbroker'] || cf['Valor'] || '0') || null,
      mktlab_link: 'https://mktlab.app/crm/leads/' + (rawLead.id || ''),
      mktlab_id: rawLead.id || null,
      data_cadastro: dc.data_cadastro,
    };

    return {
      payload: payload,
      canalSource: c.source,
      canalRaw: c.raw,
      dateSource: dc.source,
      warnings: warnings,
    };
  }

  // Validates a payload. Returns { ok, errors }.
  function validatePayload(payload) {
    var errors = [];
    if (!payload) return { ok: false, errors: ['payload vazio'] };
    if (!payload.empresa) errors.push('empresa obrigatória');
    if (!payload.canal) errors.push('canal ausente');
    else if (VALID_CANAIS.indexOf(payload.canal) < 0) errors.push('canal inválido: ' + payload.canal);
    if (!payload.data_cadastro) errors.push('data_cadastro obrigatória');
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.data_cadastro)) errors.push('data_cadastro em formato inválido');
    return { ok: errors.length === 0, errors: errors };
  }

  // Dev tests — ativar via window.__TEST_NORMALIZE__ = true no console
  if (typeof window !== 'undefined' && window.__TEST_NORMALIZE__) {
    var rawBB = { id: 'x1', companyName: 'Acme', phone: '+5511999', columnUpdatedAt: '2026-04-07T10:00:00Z' };
    var detBB = { basicData: { acquisitionChannel: { title: 'Blackbox' } }, customFields: {} };
    var nBB = normalizeLead(rawBB, detBB, 'outbound');
    console.assert(nBB.payload.canal === 'blackbox', 'T1 canal=blackbox');
    console.assert(nBB.canalSource === 'basic_data', 'T1 source=basic_data');
    console.assert(nBB.payload.data_cadastro === '2026-04-07', 'T1 data_cadastro');
    console.assert(validatePayload(nBB.payload).ok, 'T1 valid');

    var rawLB = { id: 'x2', companyName: 'Foo', columnName: 'Leadbroker' };
    var detLB = { basicData: {}, customFields: { 'Status Leadbroker': 'Leadbroker ativo' } };
    var nLB = normalizeLead(rawLB, detLB, 'blackbox');
    console.assert(nLB.payload.canal === 'leadbroker', 'T2 canal=leadbroker (custom_field vence dropdown)');

    var rawUnk = { id: 'x3', companyName: 'Bar' };
    var nUnk = normalizeLead(rawUnk, { basicData: {}, customFields: {} }, 'outbound');
    console.assert(nUnk.canalSource === 'fallback_dropdown', 'T3 source=fallback');
    console.assert(nUnk.warnings.length > 0, 'T3 warnings');

    var invalid = { empresa: null, canal: 'foo', data_cadastro: null };
    console.assert(!validatePayload(invalid).ok, 'T4 validator rejeita');
    console.log('[normalizeLead] tests OK');
  }


  // ============================================================
  // UI - Inject side panel into the MKTLAB page
  // ============================================================
  function createUI() {
    var panel = document.createElement('div');
    panel.id = 'sh-importer-panel';
    panel.innerHTML = '\
    <style>\
      #sh-importer-panel { position:fixed; top:0; right:0; width:360px; height:100vh; background:#121212; color:#f5f5f5; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:13px; z-index:99999; box-shadow:-4px 0 20px rgba(0,0,0,0.5); display:flex; flex-direction:column; overflow:hidden; }\
      #sh-importer-panel * { box-sizing:border-box; }\
      .sh-header { background:#1e1e1e; padding:10px 14px; border-bottom:1px solid #2e2e2e; display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }\
      .sh-header h1 { font-size:14px; font-weight:600; color:#f5f5f5; margin:0; }\
      .sh-badge { background:#e63946; color:white; padding:2px 8px; border-radius:10px; font-size:10px; font-weight:600; }\
      .sh-close { background:none; border:none; color:#666; font-size:18px; cursor:pointer; padding:4px; }\
      .sh-close:hover { color:#e63946; }\
      .sh-body { flex:1; overflow-y:auto; }\
      .sh-section { padding:10px 14px; border-bottom:1px solid #1e1e1e; }\
      .sh-section-title { font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#a0a0a0; margin-bottom:6px; font-weight:600; }\
      .sh-label { display:block; font-size:11px; color:#a0a0a0; margin-bottom:3px; font-weight:500; }\
      .sh-input,.sh-select { width:100%; padding:7px 9px; background:#1e1e1e; border:1px solid #2e2e2e; border-radius:5px; color:#f5f5f5; font-size:12px; outline:none; margin-bottom:8px; }\
      .sh-input:focus,.sh-select:focus { border-color:#e63946; }\
      .sh-row { display:flex; gap:6px; }\
      .sh-row>* { flex:1; }\
      .sh-btn { width:100%; padding:9px; border:none; border-radius:5px; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:5px; }\
      .sh-btn-primary { background:#e63946; color:white; }\
      .sh-btn-primary:hover { background:#ff4d5a; }\
      .sh-btn-primary:disabled { background:#252525; color:#666; cursor:not-allowed; }\
      .sh-btn-secondary { background:#252525; color:#f5f5f5; }\
      .sh-btn-secondary:hover { background:#383838; }\
      .sh-btn-sm { width:auto; padding:5px 10px; font-size:11px; }\
      .sh-status { display:flex; align-items:center; gap:5px; margin-bottom:6px; font-size:12px; }\
      .sh-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }\
      .sh-dot-green { background:#22c55e; }\
      .sh-dot-yellow { background:#facc15; }\
      .sh-dot-red { background:#ef4444; }\
      .sh-summary { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:6px; }\
      .sh-card { background:#1e1e1e; padding:8px; border-radius:5px; text-align:center; border:1px solid #2e2e2e; }\
      .sh-card .n { font-size:18px; font-weight:700; }\
      .sh-card .l { font-size:9px; color:#a0a0a0; text-transform:uppercase; }\
      .sh-card.green .n { color:#22c55e; }\
      .sh-card.yellow .n { color:#facc15; }\
      .sh-card.red .n { color:#ef4444; }\
      .sh-card.blue .n { color:#3b82f6; }\
      .sh-lead-list { max-height:350px; overflow-y:auto; }\
      .sh-lead { display:flex; align-items:flex-start; gap:6px; padding:6px; border-radius:5px; border:1px solid #2e2e2e; margin-bottom:3px; background:#1e1e1e; }\
      .sh-lead:hover { background:#252525; }\
      .sh-lead.dup { opacity:0.45; }\
      .sh-lead input[type=checkbox] { width:15px; height:15px; margin-top:2px; accent-color:#e63946; flex-shrink:0; }\
      .sh-lead-info { flex:1; min-width:0; }\
      .sh-lead-name { font-weight:600; font-size:12px; color:#f5f5f5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\
      .sh-lead-meta { font-size:10px; color:#a0a0a0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\
      .sh-tag { display:inline-block; padding:1px 5px; border-radius:3px; font-size:9px; font-weight:600; }\
      .sh-tag-dup { background:#e6394620; color:#e63946; }\
      .sh-tag-new { background:#22c55e20; color:#22c55e; }\
      .sh-progress { width:100%; height:5px; background:#1e1e1e; border-radius:3px; overflow:hidden; margin:6px 0; }\
      .sh-progress-fill { height:100%; background:#e63946; border-radius:3px; transition:width 0.3s; width:0%; }\
      .sh-toast { position:absolute; bottom:12px; left:12px; right:12px; padding:8px 12px; border-radius:6px; font-size:11px; font-weight:500; z-index:100; opacity:0; transition:opacity 0.3s; pointer-events:none; }\
      .sh-toast.show { opacity:1; }\
      .sh-toast-ok { background:#22c55e20; color:#22c55e; border:1px solid #22c55e40; }\
      .sh-toast-err { background:#ef444420; color:#ef4444; border:1px solid #ef444440; }\
      .sh-select-bar { display:flex; align-items:center; justify-content:space-between; padding:5px 7px; background:#1e1e1e; border-radius:5px; margin-bottom:6px; font-size:11px; border:1px solid #2e2e2e; }\
      .sh-select-bar label { display:flex; align-items:center; gap:5px; cursor:pointer; color:#f5f5f5; margin:0; }\
      .sh-hidden { display:none!important; }\
      .sh-spinner { display:inline-block; width:12px; height:12px; border:2px solid #252525; border-top-color:#e63946; border-radius:50%; animation:shspin 0.6s linear infinite; }\
      @keyframes shspin { to { transform:rotate(360deg); } }\
      #sh-importer-panel ::-webkit-scrollbar { width:5px; }\
      #sh-importer-panel ::-webkit-scrollbar-track { background:transparent; }\
      #sh-importer-panel ::-webkit-scrollbar-thumb { background:#2e2e2e; border-radius:3px; }\
    </style>\
    <div class="sh-header">\
      <div style="display:flex;align-items:center;gap:6px"><h1>SalesHub</h1><span class="sh-badge">Importador</span></div>\
      <button class="sh-close" id="sh-close">&times;</button>\
    </div>\
    <div class="sh-body">\
      <!-- LOGIN -->\
      <div id="sh-login">\
        <div class="sh-section">\
          <div class="sh-section-title">Login SalesHub</div>\
          <label class="sh-label">Email</label>\
          <input class="sh-input" type="email" id="sh-email" placeholder="seu@email.com">\
          <label class="sh-label">Senha</label>\
          <input class="sh-input" type="password" id="sh-pass" placeholder="Senha">\
          <button class="sh-btn sh-btn-primary" id="sh-btn-login">Entrar</button>\
          <div id="sh-login-err" style="color:#ef4444;font-size:11px;margin-top:6px;display:none"></div>\
        </div>\
      </div>\
      <!-- MAIN -->\
      <div id="sh-main" class="sh-hidden">\
        <div class="sh-section" style="padding:6px 14px;background:#1e1e1e;border-bottom:1px solid #2e2e2e;display:flex;align-items:center;justify-content:space-between">\
          <span style="font-size:11px;color:#a0a0a0">Logado: <strong id="sh-user" style="color:#f5f5f5">-</strong></span>\
          <button class="sh-btn sh-btn-sm sh-btn-secondary" id="sh-btn-logout">Sair</button>\
        </div>\
        <!-- STEP CONFIG -->\
        <div id="sh-step-config">\
          <div class="sh-section">\
            <div class="sh-section-title">1. Colunas MKTLAB</div>\
            <div class="sh-status"><span class="sh-dot sh-dot-yellow" id="sh-col-dot"></span><span id="sh-col-text">Detectando...</span></div>\
            <button class="sh-btn sh-btn-secondary sh-btn-sm" id="sh-btn-scan" style="margin-bottom:6px">Escanear colunas</button>\
            <div id="sh-col-select" class="sh-hidden">\
              <label class="sh-label">Coluna do funil</label>\
              <select class="sh-select" id="sh-column"><option value="">Selecione...</option></select>\
            </div>\
          </div>\
          <div class="sh-section">\
            <div class="sh-section-title">2. Filtros</div>\
            <div class="sh-row">\
              <div><label class="sh-label">Data inicio</label><input class="sh-input" type="date" id="sh-date-start"></div>\
              <div><label class="sh-label">Data fim</label><input class="sh-input" type="date" id="sh-date-end"></div>\
            </div>\
          </div>\
          <div class="sh-section">\
            <div class="sh-section-title">3. Canal de aquisicao</div>\
            <label class="sh-label">Canal dos leads importados</label>\
            <select class="sh-select" id="sh-canal">\
              <option value="outbound">Outbound</option>\
              <option value="blackbox">BlackBox</option>\
              <option value="leadbroker">LeadBroker</option>\
              <option value="recomendacao">Recomendacao</option>\
              <option value="indicacao">Indicacao</option>\
              <option value="recovery">Recovery</option>\
            </select>\
          </div>\
          <div class="sh-section">\
            <div class="sh-section-title">4. Atribuicao SDR</div>\
            <label class="sh-label">Atribuir leads para</label>\
            <select class="sh-select" id="sh-sdr"><option value="">Carregando...</option></select>\
          </div>\
          <div class="sh-section">\
            <button class="sh-btn sh-btn-primary" id="sh-btn-fetch" disabled>Buscar Leads</button>\
          </div>\
        </div>\
        <!-- STEP PREVIEW -->\
        <div id="sh-step-preview" class="sh-hidden">\
          <div class="sh-section">\
            <div class="sh-section-title">Preview</div>\
            <div class="sh-summary" id="sh-preview-summary"></div>\
\
            <div class="sh-select-bar"><label><input type="checkbox" id="sh-select-all" checked> <span id="sh-select-count">0 selecionados</span></label><button class="sh-btn sh-btn-secondary sh-btn-sm" id="sh-btn-back">Voltar</button></div>\
            <div class="sh-lead-list" id="sh-lead-list"></div>\
          </div>\
          <div class="sh-section">\
            <button class="sh-btn sh-btn-primary" id="sh-btn-import">Importar Selecionados</button>\
          </div>\
        </div>\
        <!-- STEP IMPORTING -->\
        <div id="sh-step-importing" class="sh-hidden">\
          <div class="sh-section">\
            <div class="sh-section-title">Importando...</div>\
            <div class="sh-progress"><div class="sh-progress-fill" id="sh-progress"></div></div>\
            <div id="sh-import-status" style="font-size:11px;color:#a0a0a0">Preparando...</div>\
          </div>\
        </div>\
        <!-- STEP DONE -->\
        <div id="sh-step-done" class="sh-hidden">\
          <div class="sh-section">\
            <div class="sh-section-title">Concluido!</div>\
            <div class="sh-summary" id="sh-done-summary"></div>\
            <button class="sh-btn sh-btn-primary" id="sh-btn-new" style="margin-top:8px">Nova Importacao</button>\
          </div>\
        </div>\
      </div>\
    </div>\
    <div class="sh-toast" id="sh-toast"></div>\
    ';
    document.body.appendChild(panel);
    return panel;
  }

  // ---- UI Helpers ----
  function $(id) { return document.getElementById(id); }

  function showToast(msg, type) {
    var t = $('sh-toast');
    t.textContent = msg;
    t.className = 'sh-toast ' + (type === 'error' ? 'sh-toast-err' : 'sh-toast-ok') + ' show';
    setTimeout(function() { t.classList.remove('show'); }, 3500);
  }

  function showStep(step) {
    ['sh-step-config','sh-step-preview','sh-step-importing','sh-step-done'].forEach(function(id) {
      $(id).classList.toggle('sh-hidden', id !== 'sh-step-' + step);
    });
  }

  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function formatPhone(p) {
    if (!p) return '';
    var c = p.replace(/\D/g, '');
    if (c.startsWith('55') && c.length >= 12) {
      return '(' + c.slice(2,4) + ') ' + c.slice(4,-4) + '-' + c.slice(-4);
    }
    return p;
  }

  // ---- Init UI ----
  createUI();

  // Close panel
  $('sh-close').onclick = function() { $('sh-importer-panel').remove(); };

  // ---- Login ----
  $('sh-btn-login').onclick = function() {
    var email = $('sh-email').value.trim();
    var pass = $('sh-pass').value;
    if (!email || !pass) { $('sh-login-err').textContent = 'Preencha email e senha'; $('sh-login-err').style.display = 'block'; return; }

    $('sh-btn-login').disabled = true;
    $('sh-btn-login').innerHTML = '<span class="sh-spinner"></span> Entrando...';
    $('sh-login-err').style.display = 'none';

    supaFetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: pass }),
    }).then(function(data) {
      supabaseSession = data;
      try { localStorage.setItem('sh_importer_session', JSON.stringify(data)); } catch(e) {}
      return loadUser();
    }).then(function() {
      $('sh-login').classList.add('sh-hidden');
      $('sh-main').classList.remove('sh-hidden');
      populateSDRs();
      scanColumns();
    }).catch(function(err) {
      $('sh-login-err').textContent = err.message;
      $('sh-login-err').style.display = 'block';
    }).finally(function() {
      $('sh-btn-login').disabled = false;
      $('sh-btn-login').textContent = 'Entrar';
    });
  };

  function loadUser() {
    return supaFetch('/rest/v1/team_members?select=*&active=eq.true&order=name').then(function(members) {
      teamMembers = members;
      var payload = JSON.parse(atob(supabaseSession.access_token.split('.')[1]));
      currentUser = members.find(function(m) { return m.email === payload.email || m.auth_user_id === payload.sub; });
      if (currentUser) $('sh-user').textContent = currentUser.name;
    });
  }

  // ---- Auto-auth: try iframe bridge to SalesHub, then localStorage fallback ----
  function tryAutoAuth() {
    return new Promise(function(resolve) {
      // 1. Try localStorage (from previous bookmarklet login)
      try {
        var stored = localStorage.getItem('sh_importer_session');
        if (stored) {
          var sess = JSON.parse(stored);
          var payload = JSON.parse(atob(sess.access_token.split('.')[1]));
          if (payload.exp * 1000 > Date.now()) {
            supabaseSession = sess;
            return resolve(true);
          }
        }
      } catch(e) {}

      // 2. Try iframe bridge to SalesHub domain (reads Supabase session from their localStorage)
      var iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = SALESHUB_URL + '/auth-bridge.html';
      var timeout = setTimeout(function() {
        cleanup();
        resolve(false);
      }, 4000);

      function onMessage(event) {
        if (event.data && event.data.type === 'SALESHUB_AUTH') {
          clearTimeout(timeout);
          cleanup();
          if (event.data.session && event.data.session.access_token) {
            supabaseSession = event.data.session;
            // Save locally for next time
            try { localStorage.setItem('sh_importer_session', JSON.stringify(supabaseSession)); } catch(e) {}
            resolve(true);
          } else {
            resolve(false);
          }
        }
      }

      function cleanup() {
        window.removeEventListener('message', onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }

      window.addEventListener('message', onMessage);
      document.body.appendChild(iframe);
    });
  }

  tryAutoAuth().then(function(hasSession) {
    if (hasSession) {
      return loadUser().then(function() {
        $('sh-login').classList.add('sh-hidden');
        $('sh-main').classList.remove('sh-hidden');
        populateSDRs();
        scanColumns();
      }).catch(function() {
        supabaseSession = null;
        // Show login on failure
      });
    }
  }).catch(function() {});

  // Logout
  $('sh-btn-logout').onclick = function() {
    supabaseSession = null;
    currentUser = null;
    try { localStorage.removeItem('sh_importer_session'); } catch(e) {}
    $('sh-login').classList.remove('sh-hidden');
    $('sh-main').classList.add('sh-hidden');
  };

  // ---- SDR dropdown ----
  function populateSDRs() {
    var sel = $('sh-sdr');
    sel.innerHTML = '<option value="">Sem atribuicao</option>';
    teamMembers.filter(function(m) { return m.active; }).forEach(function(m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name + ' (' + m.role + ')';
      if (currentUser && m.id === currentUser.id) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // ---- Column scanning ----
  function scanColumns() {
    var dot = $('sh-col-dot');
    var text = $('sh-col-text');
    dot.className = 'sh-dot sh-dot-yellow';
    text.textContent = 'Escaneando colunas...';

    var cols = extractColumns();
    if (cols.length === 0) {
      dot.className = 'sh-dot sh-dot-red';
      text.textContent = 'Nenhuma coluna encontrada. Esteja na pagina de Leads.';
      return;
    }

    text.textContent = 'Resolvendo IDs (' + cols.length + ' colunas)...';

    resolveColumnIds(cols).then(function(resolved) {
      detectedColumns = resolved.filter(function(c) { return c.columnId; });
      if (detectedColumns.length > 0) {
        dot.className = 'sh-dot sh-dot-green';
        text.textContent = detectedColumns.length + ' colunas detectadas';
        $('sh-col-select').classList.remove('sh-hidden');

        var sel = $('sh-column');
        sel.innerHTML = '<option value="">Selecione...</option>';
        detectedColumns.forEach(function(c) {
          var opt = document.createElement('option');
          opt.value = c.columnId;
          opt.textContent = c.name + ' (' + c.total + ' leads)';
          sel.appendChild(opt);
        });
        updateFetchBtn();
      } else {
        dot.className = 'sh-dot sh-dot-red';
        text.textContent = 'Colunas sem leads detectados. Tente recarregar a pagina.';
      }
    });
  }

  $('sh-btn-scan').onclick = scanColumns;

  // ---- Fetch leads ----
  function updateFetchBtn() {
    $('sh-btn-fetch').disabled = !$('sh-column').value;
  }
  $('sh-column').onchange = updateFetchBtn;

  $('sh-btn-fetch').onclick = function() {
    var columnId = $('sh-column').value;
    if (!columnId) return;

    $('sh-btn-fetch').disabled = true;
    $('sh-btn-fetch').innerHTML = '<span class="sh-spinner"></span> Buscando...';

    fetchAllLeads(columnId).then(function(leads) {
      fetchedLeads = leads;

      // Date filter
      var ds = $('sh-date-start').value;
      var de = $('sh-date-end').value;
      if (ds || de) {
        var start = ds ? new Date(ds + 'T00:00:00') : new Date(0);
        var end = de ? new Date(de + 'T23:59:59') : new Date('2099-01-01');
        fetchedLeads = fetchedLeads.filter(function(l) {
          var dt = new Date(l.columnUpdatedAt || l.createdAt);
          return dt >= start && dt <= end;
        });
      }

      showToast(fetchedLeads.length + ' leads encontrados!', 'success');
      return enrichLeadsData();
    }).then(function() {
      renderPreview();
      showStep('preview');
    }).catch(function(err) {
      showToast(err.message, 'error');
    }).finally(function() {
      $('sh-btn-fetch').disabled = false;
      $('sh-btn-fetch').textContent = 'Buscar Leads';
      updateFetchBtn();
    });
  };

  // ---- Enrich leads + check duplicates + normalize (canal + data_cadastro) ----
  function enrichLeadsData() {
    return supaFetch('/rest/v1/leads?select=id,empresa,mktlab_id,mktlab_link')
      .then(function(existing) {
        var existingIds = {};
        var existingLinks = {};
        var existingEmpresas = {};
        existing.forEach(function(l) {
          if (l.mktlab_id) existingIds[l.mktlab_id] = true;
          if (l.mktlab_link) existingLinks[l.mktlab_link] = true;
          existingEmpresas[l.empresa.trim().toLowerCase()] = true;
        });

        enrichedLeads = [];
        selectedIds = {};

        var fallbackDropdown = $('sh-canal').value || '';

        // Stub first to preserve order, then fetch detail+normalize in sequence (throttle 150ms)
        fetchedLeads.forEach(function(lead) {
          var mktlabId = lead.id;
          var mktlabLink = 'https://mktlab.app/crm/leads/' + lead.id;
          var empresa = (lead.companyName || lead.title || '').trim();
          var isDup = !!(existingIds[mktlabId] || existingLinks[mktlabLink] || existingEmpresas[empresa.toLowerCase()]);

          enrichedLeads.push({
            mktlabId: mktlabId,
            mktlabLink: mktlabLink,
            empresa: empresa,
            contato: lead.title || '',
            telefone: lead.phone || '',
            email: lead.email || '',
            cnpj: lead.taxId || '',
            isDuplicate: isDup,
            // Normalization slots — filled by enrich loop
            _raw: lead,
            _detail: null,
            _normalized: null,
            _validation: null,
          });

          if (!isDup) selectedIds[mktlabId] = true;
        });

        // Sequential enrich (avoids MKTLAB rate limit)
        return new Promise(function(resolve) {
          var i = 0;
          function step() {
            if (i >= enrichedLeads.length) {
              showToast('Enriquecimento concluído (' + enrichedLeads.length + ')', 'success');
              return resolve();
            }
            var e = enrichedLeads[i];
            // Skip detail fetch for duplicates (won't be imported anyway)
            if (e.isDuplicate) {
              var nDup = normalizeLead(e._raw, { basicData: {}, customFields: {} }, fallbackDropdown);
              e._normalized = nDup;
              e._validation = validatePayload(nDup.payload);
              i++; return step();
            }
            showToast('Enriquecendo ' + (i + 1) + '/' + enrichedLeads.length + '...', 'success');
            fetchLeadDetail(e.mktlabId).then(function(detail) {
              e._detail = detail;
              var n = normalizeLead(e._raw, detail, fallbackDropdown);
              e._normalized = n;
              e._validation = validatePayload(n.payload);
            }).catch(function(err) {
              console.warn('fetchLeadDetail falhou para', e.mktlabId, err && err.message);
              var n = normalizeLead(e._raw, { basicData: {}, customFields: {} }, fallbackDropdown);
              e._normalized = n;
              e._validation = validatePayload(n.payload);
            }).finally(function() {
              i++;
              setTimeout(step, 150);
            });
          }
          step();
        });
      });
  }

  // Cor do indicador de canal conforme fonte
  function canalDot(source) {
    if (source === 'basic_data') return 'sh-dot-green';
    if (source === 'custom_field' || source === 'column_name') return 'sh-dot-green';
    if (source === 'fallback_dropdown') return 'sh-dot-yellow';
    return 'sh-dot-red';
  }
  function dateDot(source) {
    if (source === 'basic_data' || source === 'column_updated_at') return 'sh-dot-green';
    if (source === 'created_at') return 'sh-dot-yellow';
    return 'sh-dot-red';
  }

  // ---- Preview ----
  function renderPreview() {
    var visible = enrichedLeads;

    var newCount = visible.filter(function(l) { return !l.isDuplicate; }).length;
    var dupCount = visible.filter(function(l) { return l.isDuplicate; }).length;
    var selCount = Object.keys(selectedIds).length;
    var invalidCount = visible.filter(function(l) {
      return !l.isDuplicate && l._validation && !l._validation.ok;
    }).length;

    $('sh-preview-summary').innerHTML =
      '<div class="sh-card blue"><div class="n">' + visible.length + '</div><div class="l">Total</div></div>' +
      '<div class="sh-card green"><div class="n">' + newCount + '</div><div class="l">Novos</div></div>' +
      '<div class="sh-card red"><div class="n">' + dupCount + '</div><div class="l">Duplicados</div></div>' +
      '<div class="sh-card ' + (invalidCount ? 'red' : 'yellow') + '"><div class="n">' + (invalidCount || selCount) + '</div><div class="l">' + (invalidCount ? 'Inválidos' : 'Selec.') + '</div></div>';

    var list = $('sh-lead-list');
    list.innerHTML = '';

    visible.forEach(function(lead) {
      var div = document.createElement('div');
      var n = lead._normalized;
      var v = lead._validation;
      var invalid = !lead.isDuplicate && v && !v.ok;
      div.className = 'sh-lead' + (lead.isDuplicate ? ' dup' : '');
      if (invalid) div.style.border = '1px solid #ef4444';

      var canalHtml = '<span style="color:#666">...</span>';
      var dateHtml = '<span style="color:#666">...</span>';
      if (n) {
        var canalTxt = n.payload.canal || '?';
        var canalTitle = 'fonte: ' + n.canalSource + (n.canalRaw ? ' ("' + n.canalRaw + '")' : '');
        canalHtml = '<span class="sh-dot ' + canalDot(n.canalSource) + '" title="' + esc(canalTitle) + '" style="display:inline-block;margin-right:3px"></span>' + esc(canalTxt);

        var dateTxt = n.payload.data_cadastro || '—';
        var dateTitle = 'fonte: ' + n.dateSource;
        dateHtml = '<span class="sh-dot ' + dateDot(n.dateSource) + '" title="' + esc(dateTitle) + '" style="display:inline-block;margin-right:3px"></span>' + esc(dateTxt);
      }

      var tagHtml;
      if (lead.isDuplicate) tagHtml = '<span class="sh-tag sh-tag-dup">JÁ EXISTE</span>';
      else if (invalid) tagHtml = '<span class="sh-tag sh-tag-dup" title="' + esc((v.errors || []).join('; ')) + '">INVÁLIDO</span>';
      else tagHtml = '<span class="sh-tag sh-tag-new">NOVO</span>';

      div.innerHTML =
        '<input type="checkbox" data-id="' + lead.mktlabId + '"' +
        (selectedIds[lead.mktlabId] ? ' checked' : '') +
        (lead.isDuplicate || invalid ? ' disabled' : '') + '>' +
        '<div class="sh-lead-info">' +
        '<div class="sh-lead-name">' + esc(lead.empresa || 'Sem nome') + '</div>' +
        '<div class="sh-lead-meta">' + esc(lead.contato) + (lead.telefone ? ' · ' + formatPhone(lead.telefone) : '') + '</div>' +
        '<div class="sh-lead-meta" style="margin-top:2px">canal: ' + canalHtml + ' · data: ' + dateHtml + '</div>' +
        tagHtml +
        '</div>';

      // Auto-deselect invalid entries
      if (invalid) delete selectedIds[lead.mktlabId];

      var cb = div.querySelector('input');
      cb.onchange = function() {
        if (cb.checked) selectedIds[lead.mktlabId] = true;
        else delete selectedIds[lead.mktlabId];
        updateSelectCount();
      };
      list.appendChild(div);
    });

    updateSelectCount();
  }

  function updateSelectCount() {
    var count = Object.keys(selectedIds).length;
    $('sh-select-count').textContent = count + ' selecionados';
    $('sh-btn-import').textContent = 'Importar ' + count + ' Leads';
    $('sh-btn-import').disabled = count === 0;
  }

  $('sh-select-all').onchange = function() {
    var checked = this.checked;
    var cbs = $('sh-lead-list').querySelectorAll('input[type=checkbox]:not(:disabled)');
    cbs.forEach(function(cb) {
      cb.checked = checked;
      if (checked) selectedIds[cb.dataset.id] = true;
      else delete selectedIds[cb.dataset.id];
    });
    updateSelectCount();
  };

  $('sh-btn-back').onclick = function() { showStep('config'); };

  // ---- Import ----
  $('sh-btn-import').onclick = function() {
    var toImport = enrichedLeads.filter(function(l) { return selectedIds[l.mktlabId]; });
    if (toImport.length === 0) return;

    showStep('importing');
    var sdrId = $('sh-sdr').value || null;
    var imported = 0, skipped = 0, errors = 0, invalid = 0;
    var i = 0;

    function importNext() {
      if (i >= toImport.length) {
        showStep('done');
        $('sh-done-summary').innerHTML =
          '<div class="sh-card green"><div class="n">' + imported + '</div><div class="l">Importados</div></div>' +
          '<div class="sh-card yellow"><div class="n">' + skipped + '</div><div class="l">Pulados</div></div>' +
          '<div class="sh-card red"><div class="n">' + (errors + invalid) + '</div><div class="l">Erros</div></div>' +
          '<div class="sh-card blue"><div class="n">' + toImport.length + '</div><div class="l">Total</div></div>';
        showToast(imported + ' leads importados!' + (invalid ? ' (' + invalid + ' inválidos)' : ''), 'success');
        return;
      }

      var lead = toImport[i];
      var pct = Math.round(((i + 1) / toImport.length) * 100);
      $('sh-progress').style.width = pct + '%';
      $('sh-import-status').textContent = (i + 1) + '/' + toImport.length + ' - ' + lead.empresa;

      // Use normalized payload from enrich phase
      var n = lead._normalized;
      var v = lead._validation || (n ? validatePayload(n.payload) : { ok: false, errors: ['não normalizado'] });

      if (!n || !v.ok) {
        invalid++;
        console.error('Inválido ' + lead.empresa + ':', v.errors);
        i++;
        return setTimeout(importNext, 10);
      }

      // Clone and attach sdr
      var payload = {};
      Object.keys(n.payload).forEach(function(k) {
        if (n.payload[k] !== null && n.payload[k] !== '' && n.payload[k] !== 0) payload[k] = n.payload[k];
      });
      // Required fields must survive the null-strip
      payload.empresa = n.payload.empresa || 'Sem nome';
      payload.canal = n.payload.canal;
      payload.data_cadastro = n.payload.data_cadastro;
      payload.status = 'sem_contato';
      if (sdrId) payload.sdr_id = sdrId;

      supaFetch('/rest/v1/leads', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(payload),
      }).then(function() {
        imported++;
      }).catch(function(err) {
        if (err.message && (err.message.includes('duplicate') || err.message.includes('unique') || err.message.includes('already'))) {
          skipped++;
        } else {
          errors++;
          console.error('Erro ' + lead.empresa + ':', err.message);
        }
      }).finally(function() {
        i++;
        setTimeout(importNext, 100);
      });
    }

    importNext();
  };

  $('sh-btn-new').onclick = function() {
    fetchedLeads = [];
    enrichedLeads = [];
    selectedIds = {};
    showStep('config');
  };

})();
