// MKTLab Lead Extractor v3
// Bookmarklet: extrai lead do mktlab.app e cria no SalesHub
(function() {
  'use strict';
  var SALESHUB_URL = 'https://gestao-comercial-rosy.vercel.app';

  // Parser BRL: "R$ 1.234,56" / "889,20" / "889.20" / 889 → 1234.56 / 889.2 / 889.2 / 889
  // Null se vazio, NaN ou <= 0.
  function parseBRL(s) {
    if (s == null) return null;
    if (typeof s === 'number') return isFinite(s) && s > 0 ? s : null;
    var str = String(s).trim().replace(/R\$\s*/gi, '').replace(/\s+/g, '');
    if (!str) return null;
    if (str.indexOf(',') >= 0) str = str.replace(/\./g, '').replace(',', '.');
    var n = parseFloat(str);
    return isFinite(n) && n > 0 ? n : null;
  }

  function getField(labelText) {
    // v4 (jun/2026): MKTLAB redesenhou a pagina do lead — labels perderam
    // as classes antigas e o valor nao e' mais span.text-sm... Estrategia
    // em camadas: tenta seletor antigo, cai pra qualquer <label>, e extrai
    // o valor por 3 caminhos (span antigo → qualquer elemento folha →
    // texto do container menos o label).
    var labels = document.querySelectorAll('label.text-sm.leading-0.font-medium.text-content-foreground');
    if (!labels.length) labels = document.querySelectorAll('label');
    var SYMBOLS_ONLY = /^[#*ⓘ\s\-–—]*$/; // #, *, ⓘ, whitespace, traços
    for (var i = 0; i < labels.length; i++) {
      var clean = labels[i].textContent.replace(/\*/g, '').replace(/ⓘ/g, '').trim();
      if (clean !== labelText) continue;
      var container = labels[i].closest('div.flex.gap-4') || labels[i].closest('div.flex.flex-col') || labels[i].parentElement.parentElement;
      if (!container) continue;
      // 1) layout antigo: span com classes conhecidas
      var valueEl = container.querySelector('span.text-sm.leading-0.font-normal.text-content-foreground');
      if (valueEl) {
        var val = valueEl.textContent.trim();
        if (val && val !== '-') return val;
      }
      // 2) layout novo: qualquer elemento folha que nao seja (nem contenha) o label
      var els = container.querySelectorAll('span, p, div');
      for (var j = 0; j < els.length; j++) {
        if (els[j] === labels[i] || els[j].contains(labels[i]) || labels[i].contains(els[j])) continue;
        var v = els[j].textContent.trim();
        if (!v || v === '-' || v === labelText || v === labels[i].textContent.trim()) continue;
        if (SYMBOLS_ONLY.test(v)) continue; // pula icones tipo "#"
        return v;
      }
      // 3) fallback: texto do container menos o texto do label (e simbolos soltos)
      var rest = (container.textContent || '')
        .replace(labels[i].textContent, '')
        .replace(/[#*ⓘ]/g, '')
        .trim();
      if (rest && rest !== '-') return rest;
    }
    return '';
  }

  var data = {
    empresa: getField('Nome da empresa') || '',
    nome_contato: getField('Nome completo') || getField('Contato Principal') || '',
    telefone: getField('Celular') || getField('Telefone') || '',
    email: getField('Email') || '',
    cnpj: getField('CNPJ/EIN') || getField('CNPJ') || '',
    faturamento: getField('Faturamento da LP') || getField('Faturamento') || (function() {
      var spans = document.querySelectorAll('span.text-sm.leading-0.font-normal.text-content-foreground');
      for (var i = 0; i < spans.length; i++) { if (/\d+.*mil|milh/i.test(spans[i].textContent)) return spans[i].textContent.trim(); }
      return '';
    })(),
    produto: getField('Produtos Marketing') || getField('Produto') || '',
    valor_lead: parseBRL(getField('Valor Leadbroker') || getField('Valor')),
    canal_aquisicao: getField('Canal de Aquisição') || getField('Canal de aquisição') || getField('Status Leadbroker') || '',
    canal_origem: getField('Canal de Origem') || '',
    mktlab_link: window.location.href,
  };

  if (!data.empresa) {
    var h = document.querySelector('h1, h2, h3');
    if (h) data.empresa = h.textContent.trim();
  }

  var ca = data.canal_aquisicao.toLowerCase();
  if (ca.includes('black')) data.canal = 'blackbox';
  else if (ca.includes('lead')) data.canal = 'leadbroker';
  else if (ca.includes('out')) data.canal = 'outbound';
  else if (ca.includes('recom')) data.canal = 'recomendacao';
  else if (ca.includes('indic')) data.canal = 'indicacao';
  else if (ca.includes('recov')) data.canal = 'recovery';
  else data.canal = 'leadbroker';

  var co = (data.canal_origem || '').toUpperCase();
  if (co.includes('GOOGLE')) data.fonte = 'GOOGLE';
  else if (co.includes('FACEBOOK') || co.includes('META')) data.fonte = 'FACEBOOK';
  else if (co.includes('ORG')) data.fonte = 'ORGANICO';
  else data.fonte = '';

  data.telefone = data.telefone.replace(/[^\d+() -]/g, '').trim();

  // Extrair ID do MKTLAB da URL (ex: mktlab.app/lead/12345 → "12345")
  var mktlab_id = '';
  var urlMatch = data.mktlab_link.match(/\/lead[s]?\/([a-zA-Z0-9-]+)/);
  if (urlMatch) mktlab_id = urlMatch[1];

  var payload = {
    empresa: data.empresa,
    nome_contato: data.nome_contato,
    telefone: data.telefone,
    email: data.email,
    cnpj: data.cnpj,
    faturamento: data.faturamento,
    produto: data.produto,
    valor_lead: data.valor_lead,
    canal: data.canal,
    fonte: data.fonte,
    mktlab_link: data.mktlab_link,
    mktlab_id: mktlab_id,
    auto_assign_sdr: true,
  };

  // Guard: as secoes da pagina do MKTLAB sao accordions (Radix) e secao
  // FECHADA e' desmontada do DOM — se "Informações do Leadbroker" estiver
  // fechada, o valor nao existe pra ser extraido. Avisa em vez de importar
  // calado sem valor (causa raiz dos leads com valor_lead null em jun/2026).
  if (!payload.valor_lead) {
    var prosseguir = confirm(
      '⚠ VALOR DO LEAD NAO ENCONTRADO na pagina.\n\n' +
      'Provavel causa: a secao "Informações do Leadbroker" esta fechada.\n' +
      'Clique nela pra expandir e clique no bookmarklet de novo.\n\n' +
      'OK = importar mesmo assim (sem valor)\n' +
      'Cancelar = abortar pra tentar de novo'
    );
    if (!prosseguir) return;
  }

  var url = SALESHUB_URL + '?mktlab_import=' + encodeURIComponent(JSON.stringify(payload));
  window.open(url, '_blank');
})();
