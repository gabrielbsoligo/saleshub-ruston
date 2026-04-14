// ============================================================
// SalesHub MKTLAB Importer - Side Panel Logic
// ============================================================

const SUPABASE_URL = 'https://iaompeiokjxbffwehhrx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMjI5MDIsImV4cCI6MjA5MDc5ODkwMn0.D-rf7H8F21LyslQxmr6AGM13kWTWs7f05OcnBt5kbxg';

// ---- State ----
let supabaseSession = null;
let currentUser = null; // team_member
let teamMembers = [];
let detectedColumns = [];
let fetchedLeads = [];      // raw leads from MKTLAB
let enrichedLeads = [];     // leads with details + duplicate check
let selectedLeadIds = new Set();

// ---- DOM Elements ----
const $ = (id) => document.getElementById(id);

// ---- Supabase helpers ----
async function supabaseFetch(path, options = {}) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (supabaseSession?.access_token) {
    headers['Authorization'] = `Bearer ${supabaseSession.access_token}`;
  }

  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error_description || `HTTP ${res.status}`);
  }
  return res.json();
}

// ---- Auth ----
async function login(email, password) {
  const data = await supabaseFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  supabaseSession = data;
  await chrome.storage.local.set({ supabaseSession: data });
  await loadCurrentUser();
}

async function loadCurrentUser() {
  if (!supabaseSession) return;

  // Get team member by auth user email
  const members = await supabaseFetch(
    `/rest/v1/team_members?select=*&active=eq.true&order=name`,
  );

  teamMembers = members;

  // Find current user by email from JWT
  const payload = JSON.parse(atob(supabaseSession.access_token.split('.')[1]));
  currentUser = members.find(m => m.email === payload.email || m.auth_user_id === payload.sub);

  if (currentUser) {
    $('user-name').textContent = currentUser.name;
  }
}

async function logout() {
  supabaseSession = null;
  currentUser = null;
  await chrome.storage.local.remove('supabaseSession');
  showView('login');
}

async function restoreSession() {
  const stored = await chrome.storage.local.get('supabaseSession');
  if (stored.supabaseSession) {
    supabaseSession = stored.supabaseSession;

    // Check if token is expired
    try {
      const payload = JSON.parse(atob(supabaseSession.access_token.split('.')[1]));
      if (payload.exp * 1000 < Date.now()) {
        // Try refresh
        try {
          const data = await supabaseFetch('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: supabaseSession.refresh_token }),
          });
          supabaseSession = data;
          await chrome.storage.local.set({ supabaseSession: data });
        } catch {
          await logout();
          return false;
        }
      }

      await loadCurrentUser();
      return true;
    } catch {
      await logout();
      return false;
    }
  }
  return false;
}

// ---- View management ----
function showView(view) {
  $('login-view').classList.toggle('active', view === 'login');
  $('main-view').classList.toggle('active', view === 'main');
}

function showStep(step) {
  ['step-config', 'step-preview', 'step-importing', 'step-done'].forEach(id => {
    $(id).classList.toggle('hidden', id !== `step-${step}`);
  });
}

// ---- Toast ----
function showToast(message, type = 'info') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// ---- Column detection ----
function updateColumnStatus(columns) {
  detectedColumns = columns;
  const dot = $('mktlab-status-dot');
  const text = $('mktlab-status-text');
  const info = $('columns-info');
  const select = $('select-column');

  if (columns.length > 0) {
    dot.className = 'status-dot green';
    text.textContent = `${columns.length} colunas detectadas`;
    info.classList.remove('hidden');

    // Populate dropdown
    select.innerHTML = '<option value="">Selecione uma coluna...</option>';
    columns.forEach(col => {
      const opt = document.createElement('option');
      opt.value = col.columnId;
      opt.textContent = `${col.name} (${col.total} leads)`;
      select.appendChild(opt);
    });

    updateFetchButton();
  } else {
    dot.className = 'status-dot yellow';
    text.textContent = 'Navegue para mktlab.app/crm/leads';
    info.classList.add('hidden');
  }
}

// Listen for column detection from content script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'COLUMNS_DETECTED') {
    updateColumnStatus(message.columns);
  }
});

// ---- SDR dropdown ----
function populateSDRDropdown() {
  const select = $('select-sdr');
  select.innerHTML = '<option value="">Sem atribuicao</option>';

  const sdrs = teamMembers.filter(m => m.active);
  sdrs.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name} (${m.role})`;
    if (currentUser && m.id === currentUser.id) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
}

// ---- Fetch leads ----
function updateFetchButton() {
  const btn = $('btn-fetch-leads');
  const columnId = $('select-column').value;
  btn.disabled = !columnId;
}

async function fetchLeads() {
  const columnId = $('select-column').value;
  if (!columnId) return;

  const btn = $('btn-fetch-leads');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Buscando...';

  try {
    // Ask content script to fetch leads
    const response = await sendToContentScript({
      type: 'FETCH_LEADS',
      columnId,
      limit: 50,
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Falha ao buscar leads');
    }

    fetchedLeads = response.leads;

    // Apply date filter
    const dateStart = $('filter-date-start').value;
    const dateEnd = $('filter-date-end').value;

    if (dateStart || dateEnd) {
      const start = dateStart ? new Date(dateStart + 'T00:00:00') : new Date(0);
      const end = dateEnd ? new Date(dateEnd + 'T23:59:59') : new Date('2099-01-01');

      fetchedLeads = fetchedLeads.filter(lead => {
        const dt = new Date(lead.columnUpdatedAt || lead.updatedAt || lead.createdAt);
        return dt >= start && dt <= end;
      });
    }

    showToast(`${fetchedLeads.length} leads encontrados!`, 'success');

    // Enrich leads with detail + check duplicates
    await enrichLeads();

    // Show preview
    renderPreview();
    showStep('preview');

  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Buscar Leads';
    updateFetchButton();
  }
}

async function enrichLeads() {
  enrichedLeads = [];

  // Get existing mktlab_ids and mktlab_links from SalesHub
  const existingLeads = await supabaseFetch(
    `/rest/v1/leads?select=id,empresa,mktlab_id,mktlab_link&mktlab_id=not.is.null`,
  );
  const existingIds = new Set(existingLeads.map(l => l.mktlab_id));
  const existingLinks = new Set(existingLeads.map(l => l.mktlab_link).filter(Boolean));

  // Also check by empresa (case insensitive)
  const allLeads = await supabaseFetch(`/rest/v1/leads?select=id,empresa`);
  const existingEmpresas = new Set(allLeads.map(l => l.empresa.trim().toLowerCase()));

  for (const lead of fetchedLeads) {
    const mktlabId = lead.id;
    const mktlabLink = `https://mktlab.app/crm/leads/${lead.id}`;
    const empresa = (lead.companyName || lead.title || '').trim();

    const isDuplicate =
      existingIds.has(mktlabId) ||
      existingLinks.has(mktlabLink) ||
      existingEmpresas.has(empresa.toLowerCase());

    enrichedLeads.push({
      ...lead,
      mktlabId,
      mktlabLink,
      empresa,
      contato: lead.title || '',
      telefone: lead.phone || '',
      email: lead.email || '',
      cnpj: lead.taxId || '',
      isDuplicate,
      canal: null, // will be set from custom fields if fetched
    });
  }

  // Pre-select non-duplicates
  selectedLeadIds.clear();
  enrichedLeads.forEach(l => {
    if (!l.isDuplicate) selectedLeadIds.add(l.mktlabId);
  });
}

// ---- Preview rendering ----
function renderPreview() {
  const canalFilter = $('filter-canal').value;
  const visibleLeads = canalFilter
    ? enrichedLeads.filter(l => l.canal === canalFilter)
    : enrichedLeads;

  const newCount = visibleLeads.filter(l => !l.isDuplicate).length;
  const dupCount = visibleLeads.filter(l => l.isDuplicate).length;

  // Summary cards
  $('preview-summary').innerHTML = `
    <div class="summary-card blue">
      <div class="number">${visibleLeads.length}</div>
      <div class="label">Total</div>
    </div>
    <div class="summary-card green">
      <div class="number">${newCount}</div>
      <div class="label">Novos</div>
    </div>
    <div class="summary-card red">
      <div class="number">${dupCount}</div>
      <div class="label">Duplicados</div>
    </div>
    <div class="summary-card yellow">
      <div class="number">${selectedLeadIds.size}</div>
      <div class="label">Selecionados</div>
    </div>
  `;

  // Lead list
  const list = $('lead-list');
  list.innerHTML = '';

  visibleLeads.forEach(lead => {
    const div = document.createElement('div');
    div.className = `lead-item${lead.isDuplicate ? ' duplicate' : ''}`;
    div.innerHTML = `
      <input type="checkbox" data-id="${lead.mktlabId}"
        ${selectedLeadIds.has(lead.mktlabId) ? 'checked' : ''}
        ${lead.isDuplicate ? 'disabled' : ''}>
      <div class="lead-info">
        <div class="lead-empresa">${escapeHtml(lead.empresa || 'Sem nome')}</div>
        <div class="lead-meta">${escapeHtml(lead.contato)} ${lead.telefone ? '· ' + formatPhone(lead.telefone) : ''}</div>
        <span class="lead-tag ${lead.isDuplicate ? 'tag-dup' : 'tag-new'}">
          ${lead.isDuplicate ? 'JA EXISTE' : 'NOVO'}
        </span>
      </div>
    `;

    const checkbox = div.querySelector('input[type="checkbox"]');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedLeadIds.add(lead.mktlabId);
      } else {
        selectedLeadIds.delete(lead.mktlabId);
      }
      updateSelectCount();
    });

    list.appendChild(div);
  });

  updateSelectCount();
}

function updateSelectCount() {
  $('select-count').textContent = `${selectedLeadIds.size} selecionados`;
  $('btn-import').textContent = `Importar ${selectedLeadIds.size} Leads`;
  $('btn-import').disabled = selectedLeadIds.size === 0;

  // Update summary selected count
  const summaryCards = $('preview-summary').querySelectorAll('.summary-card.yellow .number');
  if (summaryCards.length) summaryCards[0].textContent = selectedLeadIds.size;
}

// ---- Select all ----
$('select-all').addEventListener('change', function () {
  const checkboxes = $('lead-list').querySelectorAll('input[type="checkbox"]:not(:disabled)');
  checkboxes.forEach(cb => {
    cb.checked = this.checked;
    const id = cb.dataset.id;
    if (this.checked) {
      selectedLeadIds.add(id);
    } else {
      selectedLeadIds.delete(id);
    }
  });
  updateSelectCount();
});

// ---- Import ----
async function importLeads() {
  const leadsToImport = enrichedLeads.filter(l => selectedLeadIds.has(l.mktlabId));
  if (leadsToImport.length === 0) return;

  showStep('importing');

  const sdrId = $('select-sdr').value || null;
  const progressBar = $('import-progress');
  const statusText = $('import-status');

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < leadsToImport.length; i++) {
    const lead = leadsToImport[i];
    const pct = Math.round(((i + 1) / leadsToImport.length) * 100);
    progressBar.style.width = `${pct}%`;
    statusText.textContent = `${i + 1}/${leadsToImport.length} - ${lead.empresa}`;

    try {
      // Fetch detail from MKTLAB (basic-data + custom-fields)
      let detail = { basicData: {}, customFields: {} };
      try {
        const detailResp = await sendToContentScript({
          type: 'FETCH_LEAD_DETAIL',
          leadId: lead.mktlabId,
        });
        if (detailResp?.success) {
          detail = detailResp.detail;
        }
      } catch (e) {
        // Continue without details
      }

      // Map canal from custom fields
      const canalAquisicao = (
        detail.customFields['Canal de Aquisição'] ||
        detail.customFields['Canal de aquisição'] ||
        detail.customFields['Status Leadbroker'] ||
        detail.basicData?.acquisitionChannel?.title ||
        ''
      ).toLowerCase();

      let canal = 'leadbroker'; // default
      if (canalAquisicao.includes('black')) canal = 'blackbox';
      else if (canalAquisicao.includes('lead')) canal = 'leadbroker';
      else if (canalAquisicao.includes('out')) canal = 'outbound';
      else if (canalAquisicao.includes('recom')) canal = 'recomendacao';
      else if (canalAquisicao.includes('indic')) canal = 'indicacao';

      // Map fonte from custom fields
      const canalOrigem = (
        detail.customFields['Canal de Origem'] || ''
      ).toUpperCase();

      let fonte = null;
      if (canalOrigem.includes('GOOGLE')) fonte = 'GOOGLE';
      else if (canalOrigem.includes('FACEBOOK') || canalOrigem.includes('META')) fonte = 'FACEBOOK';
      else if (canalOrigem.includes('ORG')) fonte = 'ORGANICO';

      // Build payload
      const payload = {
        empresa: lead.empresa || 'Sem nome',
        nome_contato: lead.contato || detail.basicData?.contactName || null,
        telefone: lead.telefone ? formatPhoneClean(lead.telefone) : null,
        email: lead.email || detail.basicData?.email || null,
        cnpj: lead.cnpj || detail.basicData?.taxId || null,
        faturamento: detail.customFields['Faturamento da LP'] || detail.customFields['Faturamento'] || null,
        produto: detail.customFields['Produtos Marketing'] || detail.customFields['Produto'] || null,
        canal,
        fonte,
        status: 'sem_contato',
        valor_lead: parseFloat(detail.customFields['Valor Leadbroker'] || detail.customFields['Valor'] || '0') || null,
        mktlab_link: lead.mktlabLink,
        mktlab_id: lead.mktlabId,
        sdr_id: sdrId,
      };

      // Remove null/empty fields
      Object.keys(payload).forEach(k => {
        if (payload[k] === null || payload[k] === '' || payload[k] === 0) delete payload[k];
      });
      // Ensure required fields
      payload.empresa = payload.empresa || 'Sem nome';
      payload.canal = payload.canal || 'leadbroker';
      payload.status = 'sem_contato';
      if (sdrId) payload.sdr_id = sdrId;

      // Insert into SalesHub
      const result = await supabaseFetch('/rest/v1/leads', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(payload),
      });

      imported++;
    } catch (err) {
      if (err.message.includes('duplicate') || err.message.includes('unique') || err.message.includes('already')) {
        skipped++;
      } else {
        errors++;
        console.error(`Erro importando ${lead.empresa}:`, err.message);
      }
    }

    // Small delay between inserts
    await new Promise(r => setTimeout(r, 100));
  }

  // Show done
  showStep('done');
  $('done-summary').innerHTML = `
    <div class="summary-card green">
      <div class="number">${imported}</div>
      <div class="label">Importados</div>
    </div>
    <div class="summary-card yellow">
      <div class="number">${skipped}</div>
      <div class="label">Pulados (dup)</div>
    </div>
    <div class="summary-card red">
      <div class="number">${errors}</div>
      <div class="label">Erros</div>
    </div>
    <div class="summary-card blue">
      <div class="number">${leadsToImport.length}</div>
      <div class="label">Total</div>
    </div>
  `;

  showToast(`${imported} leads importados com sucesso!`, 'success');
}

// ---- Communication with content script ----
function sendToContentScript(message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        reject(new Error('Nenhuma aba ativa. Abra o mktlab.app/crm/leads'));
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error('Extensao nao conectada ao MKTLAB. Recarregue a pagina.'));
          return;
        }
        resolve(response);
      });
    });
  });
}

// ---- Helpers ----
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatPhone(phone) {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  if (clean.startsWith('55') && clean.length >= 12) {
    const ddd = clean.slice(2, 4);
    const num = clean.slice(4);
    return `(${ddd}) ${num.slice(0, -4)}-${num.slice(-4)}`;
  }
  return phone;
}

function formatPhoneClean(phone) {
  if (!phone) return '';
  // Keep +55 format
  const clean = phone.replace(/[^\d+]/g, '');
  if (clean.startsWith('55') && !clean.startsWith('+')) return '+' + clean;
  return clean;
}

// ---- Event listeners ----
$('btn-login').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const errEl = $('login-error');

  if (!email || !password) {
    errEl.textContent = 'Preencha email e senha';
    errEl.style.display = 'block';
    return;
  }

  $('btn-login').disabled = true;
  $('btn-login').innerHTML = '<span class="spinner"></span> Entrando...';
  errEl.style.display = 'none';

  try {
    await login(email, password);
    showView('main');
    populateSDRDropdown();
    requestColumnsFromContentScript();
  } catch (err) {
    errEl.textContent = err.message || 'Erro ao fazer login';
    errEl.style.display = 'block';
  } finally {
    $('btn-login').disabled = false;
    $('btn-login').textContent = 'Entrar';
  }
});

$('btn-logout').addEventListener('click', logout);
$('select-column').addEventListener('change', updateFetchButton);
$('btn-fetch-leads').addEventListener('click', fetchLeads);
$('btn-import').addEventListener('click', importLeads);
$('btn-back-config').addEventListener('click', () => showStep('config'));
$('btn-new-import').addEventListener('click', () => {
  fetchedLeads = [];
  enrichedLeads = [];
  selectedLeadIds.clear();
  showStep('config');
});

$('filter-canal').addEventListener('change', renderPreview);
$('btn-rescan').addEventListener('click', () => {
  const dot = $('mktlab-status-dot');
  const text = $('mktlab-status-text');
  dot.className = 'status-dot yellow';
  text.textContent = 'Escaneando...';
  requestColumnsFromContentScript();
});

// ---- Request columns from content script ----
function requestColumnsFromContentScript() {
  const dot = $('mktlab-status-dot');
  const text = $('mktlab-status-text');

  sendToContentScript({ type: 'RESCAN_COLUMNS' })
    .then(resp => {
      if (resp?.success && resp.columns?.length > 0) {
        updateColumnStatus(resp.columns);
      } else {
        dot.className = 'status-dot yellow';
        text.textContent = 'Aguardando deteccao... Navegue no MKTLAB.';
      }
    })
    .catch(() => {
      dot.className = 'status-dot red';
      text.textContent = 'MKTLAB nao conectado. Abra mktlab.app/crm/leads e recarregue.';
    });
}

// ---- Init ----
(async function init() {
  const hasSession = await restoreSession();
  if (hasSession) {
    showView('main');
    populateSDRDropdown();
    requestColumnsFromContentScript();
  } else {
    showView('login');
  }
})();
