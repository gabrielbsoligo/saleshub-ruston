// MKTLab Lead Extractor v3
// Bookmarklet: extrai lead do mktlab.app e cria no SalesHub
(function() {
  'use strict';
  var SALESHUB_URL = 'https://gestao-comercial-rosy.vercel.app';

  function getField(labelText) {
    var labels = document.querySelectorAll('label.text-sm.leading-0.font-medium.text-content-foreground');
    for (var i = 0; i < labels.length; i++) {
      var clean = labels[i].textContent.replace(/\*/g, '').replace(/ⓘ/g, '').trim();
      if (clean === labelText) {
        var container = labels[i].closest('div.flex.gap-4') || labels[i].closest('div.flex.flex-col') || labels[i].parentElement.parentElement;
        if (container) {
          var valueEl = container.querySelector('span.text-sm.leading-0.font-normal.text-content-foreground');
          if (valueEl) {
            var val = valueEl.textContent.trim();
            return (val && val !== '-') ? val : '';
          }
          var spans = container.querySelectorAll('span.font-normal, span.text-content-foreground');
          for (var j = 0; j < spans.length; j++) {
            if (spans[j] !== labels[i]) {
              var v = spans[j].textContent.trim();
              if (v && v !== '-' && v !== labelText) return v;
            }
          }
        }
      }
    }
    return '';
  }

  var data = {
    empresa: getField('Nome da empresa') || '',
    nome_contato: getField('Nome completo') || getField('Contato Principal') || '',
    telefone: getField('Celular') || getField('Telefone') || '',
    email: getField('Email') || '',
    cnpj: getField('CNPJ/EIN') || getField('CNPJ') || '',
    faturamento: getField('Faturamento da LP') || getField('Faturamento') || '',
    produto: getField('Produtos Marketing') || getField('Produto') || '',
    valor_lead: getField('Valor Leadbroker') || getField('Valor') || '',
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

  var url = SALESHUB_URL + '?mktlab_import=' + encodeURIComponent(JSON.stringify(payload));
  window.open(url, '_blank');
})();
