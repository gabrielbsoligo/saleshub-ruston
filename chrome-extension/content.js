// ============================================================
// Content Script - Runs on mktlab.app/crm/leads*
// Extracts columns from DOM + proxies API calls to MKTLAB
// ============================================================

(() => {
  'use strict';

  // Store detected columns: { columnId, name, total }
  let detectedColumns = [];

  // ---- 1. Intercept fetch to capture column list requests (for future navigations) ----
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const response = await originalFetch.apply(this, args);

    if (url.includes('/api/leads/list') && url.includes('columnId=')) {
      try {
        const clone = response.clone();
        const data = await clone.json();
        const urlObj = new URL(url, window.location.origin);
        const columnId = urlObj.searchParams.get('columnId');
        if (columnId && data.total !== undefined) {
          if (!detectedColumns.find(c => c.columnId === columnId)) {
            detectedColumns.push({ columnId, total: data.total, name: null });
            matchColumnsWithDOM();
          }
        }
      } catch (e) { /* ignore */ }
    }

    return response;
  };

  // ---- 2. Extract columns from DOM by scraping headings + lead links ----
  async function extractColumnsFromDOM() {
    // Find all column containers in the kanban view
    // Structure: heading (column name) → "X leads" text → lead links
    const main = document.querySelector('main');
    if (!main) return [];

    const columns = [];

    // Strategy: find all headings that are column titles
    // They're followed by "X leads" and then lead card links
    const allElements = main.querySelectorAll('*');
    let currentColumn = null;
    let firstLeadId = null;

    for (const el of allElements) {
      // Detect column heading (h2, h3, or elements with heading role)
      const isHeading = (
        el.tagName === 'H2' || el.tagName === 'H3' ||
        el.getAttribute('role') === 'heading' ||
        (el.tagName === 'HEADING')
      );

      if (isHeading) {
        const text = el.textContent.trim();
        // Skip if it's just a count like "71 leads"
        if (text && !text.match(/^\d+\s*leads?$/i)) {
          // Save previous column if we found a lead
          if (currentColumn && firstLeadId) {
            currentColumn.firstLeadId = firstLeadId;
            columns.push(currentColumn);
          }

          currentColumn = { name: text, total: 0, firstLeadId: null, columnId: null };
          firstLeadId = null;
        }
      }

      // Detect "X leads" count
      if (currentColumn && !currentColumn.total) {
        const text = el.textContent.trim();
        const countMatch = text.match(/^(\d+)\s*leads?$/i);
        if (countMatch) {
          currentColumn.total = parseInt(countMatch[1]);
        }
      }

      // Detect first lead link under this column
      if (currentColumn && !firstLeadId && el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        const leadMatch = href.match(/\/crm\/leads\/([a-f0-9-]+)/);
        if (leadMatch) {
          firstLeadId = leadMatch[1];
        }
      }
    }

    // Don't forget the last column
    if (currentColumn && firstLeadId) {
      currentColumn.firstLeadId = firstLeadId;
      columns.push(currentColumn);
    }

    // Also catch columns with 0 leads (no lead link found)
    // Re-scan for those
    const headings = main.querySelectorAll('h2, h3, [role="heading"]');
    for (const h of headings) {
      const name = h.textContent.trim();
      if (name && !name.match(/^\d+\s*leads?$/i)) {
        if (!columns.find(c => c.name === name)) {
          columns.push({ name, total: 0, firstLeadId: null, columnId: null });
        }
      }
    }

    return columns;
  }

  // ---- 3. Resolve columnIds by fetching first lead's data ----
  async function resolveColumnIds(columns) {
    for (const col of columns) {
      if (col.columnId) continue;
      if (!col.firstLeadId) continue;

      try {
        // Fetch lead's basic-data to get its columnId
        const data = await apiFetch(`https://mktlab.app/crm/api/leads/${col.firstLeadId}/basic-data`);
        if (data && data.columnId) {
          col.columnId = data.columnId;
        }
      } catch (e) {
        // Try fetching from list API with a small page
        try {
          // We can try to find this lead in a list call
          // Actually, let's try the card endpoint
          const data = await apiFetch(`https://mktlab.app/crm/api/leads/list?page=1&limit=1&columnId=&personalizedFilterId=&query=${encodeURIComponent(col.name)}`);
          // This might not work, but worth trying
        } catch (e2) { /* skip */ }
      }

      // Small delay
      await new Promise(r => setTimeout(r, 150));
    }

    return columns;
  }

  // ---- 4. Full column scan ----
  async function fullColumnScan() {
    // First check if we already have columns from fetch intercept
    if (detectedColumns.length > 0 && detectedColumns.every(c => c.name)) {
      notifySidePanel();
      return detectedColumns;
    }

    // Extract from DOM
    const domColumns = await extractColumnsFromDOM();

    if (domColumns.length === 0) {
      return [];
    }

    // If we have intercepted columns, merge with DOM data
    if (detectedColumns.length > 0) {
      // Match by total count or order
      for (let i = 0; i < domColumns.length; i++) {
        const intercepted = detectedColumns.find(c =>
          c.total === domColumns[i].total && !c.name
        ) || detectedColumns[i];

        if (intercepted && intercepted.columnId) {
          domColumns[i].columnId = intercepted.columnId;
        }
      }
    }

    // Resolve missing columnIds via API
    const needsResolving = domColumns.filter(c => !c.columnId && c.firstLeadId);
    if (needsResolving.length > 0) {
      await resolveColumnIds(domColumns);
    }

    // Update detected columns
    detectedColumns = domColumns.filter(c => c.columnId);

    notifySidePanel();
    return detectedColumns;
  }

  function matchColumnsWithDOM() {
    fullColumnScan();
  }

  function notifySidePanel() {
    const columns = detectedColumns
      .filter(c => c.columnId)
      .map(c => ({
        columnId: c.columnId,
        name: c.name || `Coluna (${c.total} leads)`,
        total: c.total,
      }));

    try {
      chrome.runtime.sendMessage({
        type: 'COLUMNS_DETECTED',
        columns,
      });
    } catch (e) { /* side panel not open yet */ }
  }

  // ---- 5. Handle messages from side panel ----
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.type === 'FETCH_LEADS') {
      fetchLeadsFromColumn(message.columnId, message.limit || 50)
        .then(leads => sendResponse({ success: true, leads }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === 'FETCH_LEAD_DETAIL') {
      fetchLeadDetail(message.leadId)
        .then(detail => sendResponse({ success: true, detail }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.type === 'RESCAN_COLUMNS') {
      fullColumnScan()
        .then(cols => sendResponse({ success: true, columns: cols }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
  });

  // ---- 6. API helpers (use page's cookies) ----
  async function apiFetch(url) {
    const res = await originalFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/plain, */*' },
      credentials: 'include',
    });
    if (res.status === 401) throw new Error('Token expirado! Recarregue a pagina do MKTLAB.');
    if (!res.ok) throw new Error(`Erro ${res.status} em ${url}`);
    return res.json();
  }

  async function fetchLeadsFromColumn(columnId, limit = 50) {
    const allLeads = [];
    let page = 1;

    while (true) {
      const url = `https://mktlab.app/crm/api/leads/list?page=${page}&limit=${limit}&columnId=${columnId}&personalizedFilterId=`;
      const data = await apiFetch(url);
      const cards = data.cards || [];

      if (cards.length === 0) break;
      allLeads.push(...cards);

      if (!data.hasMore || (data.totalPages && page >= data.totalPages)) break;
      page++;
      await new Promise(r => setTimeout(r, 300));
    }

    return allLeads;
  }

  async function fetchLeadDetail(leadId) {
    let basicData = {};
    try {
      basicData = await apiFetch(`https://mktlab.app/crm/api/leads/${leadId}/basic-data`);
    } catch (e) {
      console.warn(`Falha basic-data ${leadId}:`, e.message);
    }

    await new Promise(r => setTimeout(r, 150));

    let customFields = {};
    try {
      const cfData = await apiFetch(`https://mktlab.app/crm/api/leads/${leadId}/custom-fields-categories`);
      customFields = parseCustomFields(cfData);
    } catch (e) {
      console.warn(`Falha custom-fields ${leadId}:`, e.message);
    }

    return { basicData, customFields };
  }

  function parseCustomFields(categoriesData) {
    const result = {};
    const categories = categoriesData.categories || categoriesData;
    if (!Array.isArray(categories)) return result;

    for (const cat of categories) {
      if (!cat.items) continue;
      for (const item of cat.items) {
        let value = '';
        if (item.answer && item.answer.length > 0) {
          value = item.answer.join('; ');
        }
        if (!value && item.answerMultiChoice && item.answerMultiChoice.length > 0) {
          const selected = item.answerMultiChoice
            .filter(opt => opt.isSelected)
            .map(opt => opt.value);
          if (selected.length > 0) value = selected.join('; ');
        }
        result[item.title] = value;
      }
    }
    return result;
  }

  // ---- 7. Initial scan after page loads ----
  function initScan() {
    // Wait for DOM to be fully rendered by SPA
    setTimeout(() => fullColumnScan(), 2000);
    setTimeout(() => fullColumnScan(), 5000); // retry
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScan);
  } else {
    initScan();
  }

  // Watch for SPA navigation (URL changes)
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detectedColumns = [];
      setTimeout(() => fullColumnScan(), 3000);
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

})();
