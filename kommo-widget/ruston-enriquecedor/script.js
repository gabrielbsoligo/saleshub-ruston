/**
 * Ruston Enriquecedor — widget privado do Kommo (Web SDK).
 * No card do lead, painel com a LUPA: abre um modal que dispara o lead pro
 * ENRIQUECEDOR (SDNA Outbound). O backend cria o lead, devolve uma nota com o
 * link de acompanhamento na hora e, ao fim da esteira, outra nota com os
 * ganchos de abordagem.
 *
 * Configuração (na instalação):
 *   secret   — segredo da integração (obrigatório; quem te passa é o time).
 *   endpoint — URL da function (opcional; tem padrão).
 *
 * Namespace: classes/estado com prefixo "rew-" pra não colidir.
 */
define(['jquery'], function ($) {
  var CustomWidget = function () {
    var self = this;
    var NS = 'rew';
    var ENDPOINT_PADRAO = 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/enriquecedor-kommo';

    function cfg() {
      var s = {};
      try { s = self.get_settings() || {}; } catch (e) { s = {}; }
      return {
        secret: (s.secret || '').toString().trim(),
        endpoint: ((s.endpoint || '').toString().trim() || ENDPOINT_PADRAO).replace(/\/$/, ''),
      };
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function leadIdAtual() {
      var m = location.pathname.match(/\/leads\/detail\/(\d+)/);
      return m ? m[1] : null;
    }

    function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

    // Busca nome + possível campo de CNPJ do lead (sessão do próprio Kommo).
    function fetchLead(id) {
      return fetch('/api/v4/leads/' + id + '?with=contacts', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }

    function acharCnpj(lead) {
      var cfs = (lead && lead.custom_fields_values) || [];
      for (var i = 0; i < cfs.length; i++) {
        var f = cfs[i];
        if (/cnpj/i.test(f.field_name || '')) {
          var v = f.values && f.values[0] && f.values[0].value;
          var d = onlyDigits(v);
          if (d.length === 14) return d;
        }
      }
      return '';
    }

    // ---------- modal ----------
    function fecharModal() { $('.' + NS + '-overlay').remove(); }

    function abrirModal() {
      var id = leadIdAtual();
      if (!id) { alert('Abra um card de lead para enriquecer.'); return; }
      fecharModal();
      var html =
        '<div class="' + NS + '-overlay">' +
        '  <div class="' + NS + '-modal">' +
        '    <div class="' + NS + '-head">🔎 Enviar pro Enriquecedor <span class="' + NS + '-x">×</span></div>' +
        '    <div class="' + NS + '-body">' +
        '      <label>CNPJ da empresa</label>' +
        '      <input type="text" class="' + NS + '-cnpj" placeholder="00.000.000/0000-00" />' +
        '      <label>Tipo de auditoria &amp; discurso</label>' +
        '      <label class="' + NS + '-radio"><input type="radio" name="' + NS + '-perfil" value="construtoras" checked /> Construtoras &amp; Incorporadoras</label>' +
        '      <label class="' + NS + '-radio"><input type="radio" name="' + NS + '-perfil" value="geral" /> Versátil (qualquer empresa)</label>' +
        '      <div class="' + NS + '-msg"></div>' +
        '      <button class="' + NS + '-go">Enriquecer este lead</button>' +
        '    </div>' +
        '  </div>' +
        '</div>';
      $('body').append(html);

      var $ov = $('.' + NS + '-overlay');
      $ov.on('click', function (e) { if (e.target === this) fecharModal(); });
      $ov.find('.' + NS + '-x').on('click', fecharModal);

      // Pré-preenche CNPJ do campo do Kommo, se existir.
      var nomeLead = '';
      fetchLead(id).then(function (lead) {
        if (!lead) return;
        nomeLead = lead.name || '';
        var cnpj = acharCnpj(lead);
        if (cnpj) $ov.find('.' + NS + '-cnpj').val(cnpj);
      });

      $ov.find('.' + NS + '-go').on('click', function () {
        var $btn = $(this);
        var $msg = $ov.find('.' + NS + '-msg');
        var c = cfg();
        var cnpj = onlyDigits($ov.find('.' + NS + '-cnpj').val());
        var perfil = $ov.find('input[name=' + NS + '-perfil]:checked').val() || 'construtoras';
        if (!c.secret) { $msg.html('<span class="' + NS + '-err">Configure o segredo nas configurações do widget.</span>'); return; }
        if (cnpj.length !== 14) { $msg.html('<span class="' + NS + '-err">CNPJ inválido — digite os 14 dígitos.</span>'); return; }

        $btn.prop('disabled', true).text('Enviando…');
        fetch(c.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-enriq-secret': c.secret },
          body: JSON.stringify({ kommo_lead_id: id, cnpj: cnpj, empresa: nomeLead, perfil: perfil }),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (res.ok && res.j && res.j.ok) {
              $msg.html(
                '<span class="' + NS + '-okmsg">✓ Enviado! A esteira está rodando — a nota com o link já chegou no card ' +
                '(atualize a página pra ver) e os ganchos voltam em outra nota ao concluir.</span>' +
                (res.j.link ? '<br/><a href="' + esc(res.j.link) + '" target="_blank" rel="noreferrer">Acompanhar no Enriquecedor ↗</a>' : ''),
              );
              $btn.text('Enviado ✓');
            } else {
              $msg.html('<span class="' + NS + '-err">Falhou: ' + esc((res.j && res.j.error) || 'erro desconhecido') + '</span>');
              $btn.prop('disabled', false).text('Enriquecer este lead');
            }
          })
          .catch(function (e) {
            $msg.html('<span class="' + NS + '-err">Falhou: ' + esc(e && e.message) + '</span>');
            $btn.prop('disabled', false).text('Enriquecer este lead');
          });
      });
    }

    // ---------- painel no card do lead ----------
    function renderPanel() {
      self.render_template({
        caption: { class_name: NS + '-panel' },
        body:
          '<div class="' + NS + '-card">' +
          '  <button class="' + NS + '-open">🔎 Enriquecer lead</button>' +
          '  <p class="' + NS + '-hint">Cria no Enriquecedor, roda a esteira completa e devolve os ganchos numa nota.</p>' +
          '</div>',
        render: '',
      });
    }

    this.callbacks = {
      render: function () {
        try {
          if (self.system().area === 'lcard') renderPanel();
        } catch (e) { if (window.console) console.error('[ruston-enriquecedor] render', e); }
        return true;
      },
      init: function () { return true; },
      bind_actions: function () {
        $(document).off('click.' + NS).on('click.' + NS, '.' + NS + '-open', abrirModal);
        return true;
      },
      settings: function () { return true; },
      onSave: function () { return true; },
      destroy: function () { fecharModal(); },
    };
    return this;
  };
  return CustomWidget;
});
