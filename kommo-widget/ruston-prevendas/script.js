/**
 * Ruston Pré-vendas — widget único do Kommo (Web SDK): NOTIFY + PRÓXIMO + TELEFONE (webphone 4com).
 *
 * - FILA: vem do servidor (edge prevendas-fila), autenticada pelo token descartável do Kommo ($authorizedAjax).
 *   O servidor lê AO VIVO no Kommo a lista de tarefas abertas do próprio usuário (fonte autoritativa) e a
 *   classifica com dados de lead da réplica/API. O widget ordena e só age sobre essa lista; com dados velhos
 *   ou falha, as ações CONTINUAM (Concluir confere a tarefa ao vivo no Kommo) com aviso discreto da idade.
 *   Vazão: cache 40 s + trava por usuário + orçamento da conta no servidor.
 * - MODO DEGRADADO (servidor indisponível): lê as próprias tarefas pela sessão do Kommo, paginado, com
 *   respeito a 429/Retry-After, e ordena só por vencimento (aviso visível).
 * - Várias abas: uma "líder" por usuário consulta; as outras usam o resultado compartilhado (localStorage).
 * - NOTIFY: pop-up + som + notificação do navegador para tarefas que vencem agora (sem inundar com backlog).
 * - PRÓXIMO: momento → origem → vencimento (PROPOSTA.md §2.3). Sem nada vencido, oferece a próxima futura.
 *   MODO CLOSER (o servidor decide pelo papel): um card por LEAD — chat sem resposta, depois reunião na janela
 *   (2 h antes até 30 min depois), depois a etapa do funil Closer na ordem configurada, e o resto no fim (§7).
 *   Nível 0 = CHAT SEM RESPOSTA (cliente falou por último e nenhum humano respondeu; decisão 26/10).
 * - TELEFONE (opcional, setting voz=Y): o ramal 4com do próprio usuário registra aqui (JsSIP sobre WSS, áudio no
 *   navegador). A credencial (HA1, nunca a senha) vem da edge prevendas-voz e fica SÓ em memória. Discar = o
 *   servidor pede à 4com, que liga para este ramal (decisão do Gabriel: atende SOZINHO a chamada integrada que chega
 *   na janela da tentativa pedida por este widget, uma vez por tentativa; o resto toca e espera o clique) e depois
 *   para o cliente. Uma aba por vez é
 *   dona do ramal (Web Locks; a 4com derrubaria o registro anterior). voz=N desliga o ramal na hora.
 *
 * O bloco "Fila" é puro (sem DOM) e é exportado em module.exports para os testes em Node.
 * Namespace: "rpv-" / "rpv_".
 */
(function () {
  // ======================================================================
  // Fila — regras puras (testadas em tests/fila.test.cjs)
  // ======================================================================
  var Fila = (function () {
    // decisão 26/10: pré-reunião = anti no-show (um momento só)
    var NIVEL = { chat_sem_resposta: 0, anti_noshow: 1, speed_to_lead: 2, conexao: 3, follow_up: 4, recuperar: 5, sem_classificacao: 9 };
    var GRUPOS_PADRAO = ['G1', 'G2', 'G3', 'G5', 'G9'];
    var COM_ORIGEM = { 4: 1, 5: 1, 7: 1 };
    var ROTULO = {
      chat_sem_resposta: 'Chat sem resposta', anti_noshow: 'Anti no-show', speed_to_lead: 'Speed to lead', conexao: 'Conexão', follow_up: 'Follow-up',
      recuperar: 'Recuperar no-show', prospeccao: 'Prospecção', sem_classificacao: 'Outras'
    };
    var ROTULO_GRUPO = { G1: 'Indicação', G2: 'Inbound', G3: 'Base própria', G5: 'Outbound', G9: 'Sem origem' };

    // prospecção: quente (G1–G3) = 7, sem origem (G9) = 7.5 (neutro), outbound (G5) = 8 — entra só pela ordem (decisão 26/10: sem corte de horário)
    function nivel(item) {
      if (item.momento === 'prospeccao') return item.grupo === 'G5' ? 8 : (item.grupo === 'G9' ? 7.5 : 7);
      var n = NIVEL[item.momento];
      return n == null ? 9 : n;
    }

    /**
     * itens: [{id, due, momento, grupo, urgente}] · cfg: {antecedencia_min, grupos}
     * retorna {fila, futura}
     */
    function ordenar(itens, cfg, agora, minutoDoDia) {
      var limite = agora + (cfg.antecedencia_min == null ? 10 : cfg.antecedencia_min) * 60;
      var grupos = cfg.grupos && cfg.grupos.length ? cfg.grupos : GRUPOS_PADRAO;
      var gi = function (g) { var i = grupos.indexOf(g); return i === -1 ? grupos.length : i; };

      var elegiveis = [], futuras = [];
      itens.forEach(function (it) {
        var x = { item: it, nivel: nivel(it) };
        if (it.urgente || !it.due || it.due <= limite) elegiveis.push(x); else futuras.push(x);
      });

      var fila = elegiveis;

      fila.sort(function (a, b) {
        if (a.nivel !== b.nivel) return a.nivel - b.nivel;
        if (COM_ORIGEM[Math.floor(a.nivel)]) { var g = gi(a.item.grupo) - gi(b.item.grupo); if (g) return g; }
        var da = a.item.due || 0, db = b.item.due || 0;
        if (da !== db) return da - db;
        return a.item.id - b.item.id;
      });
      futuras.sort(function (a, b) { return ((a.item.due || 0) - (b.item.due || 0)) || (a.item.id - b.item.id); });
      return { fila: fila.map(function (x) { return x.item; }), futura: futuras.length ? futuras[0].item : null };
    }

    /** Próximo destino: 1º da fila que não é a entidade aberta; sem fila, a futura (se não for a aberta). */
    function proximoDe(fila, futura, aberta) {
      var mesma = function (q) { return aberta && q.etype === aberta.etype && q.eid === aberta.eid; };
      for (var i = 0; i < fila.length; i++) if (!mesma(fila[i])) return { item: fila[i], futura: false };
      if (futura && !mesma(futura)) return { item: futura, futura: true };
      return null;
    }

    /**
     * Notificações: só tarefas que vencem AGORA (entre agora-30min e agora+lookahead), não vistas, no máx.
     * `max` por ciclo (o resto vira um aviso-resumo). O "visto" guarda só ids ainda abertos (sem expulsar
     * ids que serão percorridos de novo).
     */
    function paraNotificar(tarefas, visto, agora, lookaheadMin, max) {
      var ini = agora - 30 * 60, fim = agora + lookaheadMin * 60, abertas = {}, novas = [];
      tarefas.forEach(function (t) {
        abertas[t.id] = 1;
        if (!t.due || t.due < ini || t.due > fim || visto[t.id]) return;
        novas.push(t);
      });
      novas.sort(function (a, b) { return a.due - b.due; });
      var proximoVisto = {};
      Object.keys(visto).forEach(function (k) { if (abertas[k]) proximoVisto[k] = 1; });
      novas.forEach(function (t) { proximoVisto[t.id] = 1; });
      return { mostrar: novas.slice(0, max), resumidas: Math.max(0, novas.length - max), visto: proximoVisto };
    }

    /**
     * Notificações para exibir: sem repetir a mesma tarefa (id) e agrupando avisos iguais do mesmo lead (mesmo texto)
     * num card só, com a contagem e os ids (fechar o card fecha todos).
     */
    function agruparNotif(pilha) {
      var porId = {}, grupos = {}, ordem = [];
      (pilha || []).forEach(function (n) {
        if (!n || porId[n.id]) return; porId[n.id] = 1;
        var k = (n.etype || 'leads') + ':' + n.eid + ':' + String(n.titulo || '');
        if (!grupos[k]) { grupos[k] = { n: n, ids: [] }; ordem.push(k); }
        grupos[k].ids.push(n.id);
      });
      return ordem.map(function (k) { var g = grupos[k], o = {}; for (var p in g.n) o[p] = g.n[p]; o.ids = g.ids; o.qtd = g.ids.length; return o; });
    }

    /** Liderança entre abas: assume se não há líder, se expirou ou se já é desta aba. */
    function devoLiderar(lock, aba, agoraMs) {
      return !lock || !lock.aba || lock.ate < agoraMs || lock.aba === aba;
    }

    /** Só uma leitura estritamente mais nova que os dados atuais pode substituí-los. */
    function leituraMaisNova(lidoEm, dadosEm) { return !dadosEm || (lidoEm > dadosEm); }

    /** A falha continua até chegar uma leitura POSTERIOR a ela (mesmo segundo ou antes não conta). */
    function falhaApos(falha, lidoEm) { return falha && !(lidoEm > falha.em) ? falha : null; }

    /** Remove tarefas marcadas localmente (concluídas/invalidadas) enquanto a marca vale (ttl ms). */
    function semMarcadas(tarefas, marcas, agoraMs, ttlMs) {
      return tarefas.filter(function (t) { var m = marcas[t.id]; return !(m && agoraMs - m < ttlMs); });
    }

    // modo degradado (sem servidor): só o que dá para saber no navegador
    function classificarLocal(t) {
      var txt = String(t.text || t.texto || '');
      if (/^CADENCIA: lead respondeu/i.test(txt)) return { momento: 'conexao', grupo: 'G9', urgente: true, acao: 'ligar', fonte: 'local' };
      return { momento: 'sem_classificacao', grupo: 'G9', urgente: false, acao: 'outro', fonte: 'local' };
    }

    // ---------------- modo CLOSER (puro; PROPOSTA §7) ----------------
    var FUNIL_CLOSER = 11010459;
    // CONTRATO NA RUA, CALL PROPOSTA AGENDADA, feedback reunião, MARCAR CALL PROPOSTA, ALTA, MÉDIA, BAIXA (decisão 26/10)
    var ETAPAS_CLOSER_PADRAO = [84456095, 110113248, 84456019, 103523344, 102174784, 102174780, 102174776];
    function chaveEnt(it) { return (it.etype || it.entity_type || 'leads') + ':' + (it.eid != null ? it.eid : it.entity_id); }
    /** Nível no modo closer: chat 0; reunião do lead na janela 0.5; etapa do funil Closer 1..N; resto/pendente 8. */
    function nivelCloser(it, cfg, agora) {
      if (it.momento === 'chat_sem_resposta') return 0;
      var ant = (cfg.antecedencia_closer_min == null ? 120 : cfg.antecedencia_closer_min) * 60;
      if (it.reuniao_em && agora >= it.reuniao_em - ant && agora <= it.reuniao_em + 30 * 60) return 0.5;
      if (it.etapa_pendente) return 8;
      var etapas = cfg.etapas && cfg.etapas.length ? cfg.etapas : ETAPAS_CLOSER_PADRAO;
      var i = Number(it.pipeline_id) === FUNIL_CLOSER ? etapas.indexOf(Number(it.status_id)) : -1;
      return i === -1 ? 8 : 1 + i;
    }
    /**
     * Fila do closer. Unidade = entidade (tipo:id). Só tarefas elegíveis (prazo ≤ agora + lookahead; chat sempre)
     * contam; a chave do lead é o MELHOR nível entre elas e a representativa é a tarefa desse nível (na reunião,
     * a de prazo mais próximo dela; senão, a mais antiga). O resto vira contagem (pendentes).
     * Futura = a tarefa mais próxima de um lead que não está na fila.
     */
    function ordenarCloser(itens, cfg, agora) {
      var limite = agora + (cfg.lookahead == null ? 15 : cfg.lookahead) * 60;
      var grupos = {}, ordemG = [], futuras = [];
      itens.forEach(function (it) {
        if (!(it.urgente || !it.due || it.due <= limite)) { futuras.push(it); return; }
        var k = chaveEnt(it);
        if (!grupos[k]) { grupos[k] = []; ordemG.push(k); }
        grupos[k].push({ it: it, n: nivelCloser(it, cfg, agora) });
      });
      var reps = ordemG.map(function (k) {
        var g = grupos[k], melhor = 99;
        g.forEach(function (x) { if (x.n < melhor) melhor = x.n; });
        var cands = g.filter(function (x) { return x.n === melhor; });
        cands.sort(function (a, b) {
          if (melhor === 0.5) { var r = a.it.reuniao_em, d = Math.abs((a.it.due || 0) - r) - Math.abs((b.it.due || 0) - r); if (d) return d; }
          return ((a.it.due || 0) - (b.it.due || 0)) || (a.it.id - b.it.id);
        });
        var copia = {}, rep0 = cands[0].it;
        for (var p in rep0) if (Object.prototype.hasOwnProperty.call(rep0, p)) copia[p] = rep0[p];
        copia.pendentes = g.length - 1; copia.nivelCloser = melhor;
        return copia;
      });
      reps.sort(function (a, b) { return (a.nivelCloser - b.nivelCloser) || ((a.due || 0) - (b.due || 0)) || (a.id - b.id); });
      var naFila = {}; reps.forEach(function (r) { naFila[chaveEnt(r)] = 1; });
      var fut = futuras.filter(function (x) { return !naFila[chaveEnt(x)]; });
      fut.sort(function (a, b) { return ((a.due || 0) - (b.due || 0)) || (a.id - b.id); });
      return { fila: reps, futura: fut.length ? fut[0] : null };
    }

    // ---------------- telefone (puro) ----------------
    /**
     * Só RÓTULO ("provavelmente a sua ligação"): chamada integrada da 4com chegando enquanto há um pedido seu.
     * NUNCA autoriza atender sozinho — o header não é prova de origem.
     */
    /** Quantos registros (Contact) a resposta do REGISTER lista para o ramal — mais de 1 = registrado em outro lugar. */
    function contarRegistros(contatos) {
      var n = 0;
      (contatos || []).forEach(function (c) { n += (String(c || '').match(/<sips?:[^>]+>/gi) || []).length || (String(c || '').trim() ? 1 : 0); });
      return n;
    }
    function chamadaPedida(integrada, pendenteAte, agoraMs) { return !!integrada && pendenteAte > agoraMs; }
    /** Decisão do Gabriel (T2): atende sozinho a chamada INTEGRADA da 4com que chega dentro da janela da tentativa
     *  que este widget acabou de pedir; a autorização é consumida no primeiro atendimento (uma por tentativa). */
    function deveAtender(integrada, pendenteAte, agoraMs, jaAtendida) { return !jaAtendida && chamadaPedida(integrada, pendenteAte, agoraMs); }

    var MSG_VOZ = {
      voz_nao_liberada: 'Telefone ainda não liberado para o seu usuário.',
      sem_ramal: 'Seu usuário não tem ramal 4com configurado no SalesHub.',
      sem_permissao: 'Você não é dono deste lead nem tem tarefa aberta nele.',
      telefone_fora_da_entidade: 'Esse telefone não é de um contato deste lead.',
      telefone_invalido: 'Telefone inválido.',
      ja_discando: 'Ligação pedida agora há pouco; aguarde 2 s.',
      telefone_invalido: 'Número inválido: use DDD + número (ex.: 47 99999-9999).',
      limite: 'Muitas tentativas; aguarde um minuto.',
      provedor_auth: 'O provedor de telefonia recusou a credencial do servidor.',
      provedor_limite: 'Limite de ligações do provedor de telefonia atingido; tente em 1 minuto.',
      provedor_indisponivel: 'O provedor de telefonia não respondeu a tempo; confira se a ligação aconteceu antes de tentar de novo.',
      nao_configurado: 'Telefone não configurado no servidor.',
      usuario_inativo: 'Usuário inativo no SalesHub.'
    };
    /** Chats só valem enquanto a leitura deles (chatsEm) tiver até maxS; depois saem (as tarefas ficam). */
    function semChatsVencidos(itens, chatsEm, agora, maxS) {
      var vencido = !chatsEm || (agora - chatsEm) > maxS;
      return vencido ? itens.filter(function (t) { return t.momento !== 'chat_sem_resposta'; }) : itens;
    }
    function mensagemVoz(erro, extra) { return (MSG_VOZ[erro] || ('Falha no telefone (' + erro + ').')) + (extra ? ' ' + extra : ''); }

    return {
      nivelCloser: nivelCloser, ordenarCloser: ordenarCloser, chaveEnt: chaveEnt, ETAPAS_CLOSER_PADRAO: ETAPAS_CLOSER_PADRAO,
      agruparNotif: agruparNotif, contarRegistros: contarRegistros, chamadaPedida: chamadaPedida, deveAtender: deveAtender, mensagemVoz: mensagemVoz, semChatsVencidos: semChatsVencidos,
      ordenar: ordenar, nivel: nivel, proximoDe: proximoDe, paraNotificar: paraNotificar,
      devoLiderar: devoLiderar, classificarLocal: classificarLocal,
      semMarcadas: semMarcadas, leituraMaisNova: leituraMaisNova, falhaApos: falhaApos, ROTULO: ROTULO, ROTULO_GRUPO: ROTULO_GRUPO
    };
  })();

  if (typeof module === 'object' && module && module.exports) { module.exports = Fila; return; }

  // ======================================================================
  // Widget
  // ======================================================================
  define(['jquery'], function ($) {
    var CustomWidget = function () {
      var self = this;
      var NS = 'rpv';
      var DEFAULTS = {
        endpoint: '', usuarios: '', position: 'top-right', offset: 70, poll_seconds: 45,
        antecedencia_min: 10, grupos: 'G1,G2,G3,G5,G9',
        sound: 'Y', lookahead_min: 15, atalho: 'Y', voz: 'N', endpoint_voz: '', debug_voz: 'N', provedor_voz: '',
        modo: '', etapas_closer: '', antecedencia_closer_min: 120
      };
      var POS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
      // 0.5.3: pílula no topo, à esquerda da coluna "Widgets" da ficha do lead (65 px) e abaixo do cabeçalho do Kommo
      var MARGEM_DIREITA = 72, MARGEM_ESQUERDA = 16;
      // degradado: no máx. 4 páginas (1000 tarefas), 1 página a cada 1,5 s, só durante falha do servidor
      var MAX_PAGINAS_DEGRADADO = 4, PASSO_PAGINA_MS = 1500, MAX_NOTIF_CICLO = 5, ATRASO_MAX_S = 600;
      var MARCA_TTL_MS = 2 * 60 * 1000;
      var CHATS_MAX_S = 180;                     // chat exibido/notificado só com leitura de até 2 min (servidor: 120 s + ciclo)          // só "concluí agora", até o servidor refletir
      var ABA = Math.random().toString(36).slice(2) + Date.now().toString(36);

      var state = {
        booted: false, destruido: false, geracao: 0, timers: [], ouvintes: [],
        uid: null, sub: 'acc', base: '', audio: null,
        itens: [], motivos: [],
        modo: 'aguardando', aviso: '', parcial: false, dadosEm: 0, rev: '', falha: null,
        fila: [], futura: null, open: false, vozAberta: false, pos: null, arrasto: null, atual: null, notif: [], resumoNotif: 0, carregando: false, carregandoEm: 0, reTentar: 0
      };
      // telefone: a credencial NUNCA fica aqui nem em storage — só dentro da config do UA do JsSIP (memória)
      var voz = { estado: 'off', msg: '', ua: null, sessao: null, tocando: false, emChamada: false, mudo: false, inicio: 0,
                  pendenteAte: 0, discando: false, manual: '', ultimoPedido: 0, aposRegistro: null, resEv: 0, resSeq: 0, resTent: 0, pedida: false, tentativa: 0, atendidaNaTentativa: -1, orientacao: -1, aviso: '', posse: 0, pedindo: 0, soltar: null, espera: 0,
                  tel: { chave: '', contatos: null, erro: '', carregando: false } };
      var posseSeq = 0;   // cada pedido de posse do ramal ganha um token; passos assíncronos conferem o token

      // ---------------- helpers ----------------
      function cfg() {
        var s = {};
        try { s = self.get_settings() || {}; } catch (e) { s = {}; }
        var pos = String(s.position || DEFAULTS.position).trim().toLowerCase();
        if (POS.indexOf(pos) === -1) pos = DEFAULTS.position;
        var int = function (v, d, min, max) { var n = parseInt(v, 10); if (isNaN(n) || n < min) n = d; return max ? Math.min(n, max) : n; };
        return {
          endpoint: String(s.endpoint || DEFAULTS.endpoint).trim(),
          usuarios: String(s.usuarios || DEFAULTS.usuarios).split(',').map(function (x) { return x.trim(); }).filter(Boolean),
          position: pos, offset: int(s.offset, DEFAULTS.offset, 0, 400),
          poll: int(s.poll_seconds, DEFAULTS.poll_seconds, 15),
          antecedencia_min: int(s.antecedencia_min, DEFAULTS.antecedencia_min, 0, 240),
          grupos: String(s.grupos || DEFAULTS.grupos).split(',').map(function (x) { return x.trim().toUpperCase(); }).filter(Boolean),
          sound: String(s.sound || DEFAULTS.sound).toUpperCase() !== 'N',
          lookahead: int(s.lookahead_min, DEFAULTS.lookahead_min, 0, 240),
          atalho: String(s.atalho || DEFAULTS.atalho).toUpperCase() !== 'N',
          voz: String(s.voz || DEFAULTS.voz).toUpperCase() === 'Y',
          endpoint_voz: String(s.endpoint_voz || '').trim(),
          debug_voz: String(s.debug_voz || 'N').toUpperCase() === 'Y',
          // provedor do telefone: '4com' ou '3c'; vazio = o servidor decide pelo cadastro do usuário
          provedor_voz: (function (p) { p = String(p || '').trim().toLowerCase(); return p === '4com' || p === '3c' ? p : ''; })(s.provedor_voz),
          // teste: só o GESTOR consegue forçar o modo (o servidor ignora para os demais)
          modo: (function (m) { m = String(m || '').trim().toLowerCase(); return m === 'sdr' || m === 'closer' ? m : ''; })(s.modo),
          etapas_closer: String(s.etapas_closer || '').split(',').map(function (x) { return parseInt(x, 10); }).filter(function (n) { return n > 0; }),
          antecedencia_closer_min: int(s.antecedencia_closer_min, DEFAULTS.antecedencia_closer_min, 0, 720)
        };
      }
      function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
      function pad(n) { return (n < 10 ? '0' : '') + n; }
      function calibrado() { var d = lsGet('desvio', null); return !!d && typeof d.s === 'number'; }
      function desvio() { var d = lsGet('desvio', null); return d && typeof d.s === 'number' ? d.s : 0; }
      // (Date.now, performance.now) da última medição DESTA aba: se o relógio do PC saltou (acerto manual/NTP), a
      // diferença entre os dois cresce; aí as amostras antigas do desvio não valem mais.
      var ultimoPar = null;
      function perfAgora() { try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : null; } catch (e) { return null; } }
      function medirDesvio(servidorAgora) {
        if (!servidorAgora) return;
        var agoraMs = Date.now(), perf = perfAgora();
        var m = Math.floor(agoraMs / 1000) - servidorAgora, d = lsGet('desvio', null) || { amostras: [] };
        var saltou = !!ultimoPar && perf !== null && Math.abs((agoraMs - ultimoPar.t) - (perf - ultimoPar.p)) > 5000;
        ultimoPar = perf !== null ? { t: agoraMs, p: perf } : null;
        var am = saltou ? [] : (d.amostras || []).filter(function (x) { return Math.abs(x - m) <= 300; });   // salto grande: recomeça
        am.push(m); am = am.slice(-10);
        lsSet('desvio', { s: Math.min.apply(null, am), amostras: am });
      }
      // relógio MONOTÔNICO (não muda com o acerto do relógio do PC): prazo da autorização de atendimento automático
      function mono() { try { if (typeof performance !== 'undefined' && performance.now) return performance.now(); } catch (e) {} return Date.now(); }
      function agoraS() { return Math.floor(Date.now() / 1000) - desvio(); }
      // Carimbos LOCAIS (falha.em; dadosEm do degradado) levam uma marca: o desvio já calibrado quando foram feitos
      // (número: já estão no referencial do servidor e NUNCA se movem — nem se o relógio do PC for corrigido depois)
      // ou null (feitos ANTES da 1ª calibração, no relógio do PC). Só os null são convertidos, uma vez, quando a
      // calibração existir. Carimbos do servidor (gerado_em, chats_em) são brutos. Snapshot antigo sem marca = null.
      function marca() { return calibrado() ? desvio() : null; }
      function alinhar(t, d) { return (d === null || d === undefined) && calibrado() ? t - desvio() : t; }
      function normalizar(s) {
        if (!s || !calibrado()) return false;
        var mudou = false;
        if (s.falha && typeof s.falha.d !== 'number') { s.falha.em = alinhar(s.falha.em, null); s.falha.d = desvio(); mudou = true; }
        var semMarca = s.dLocal === null || (s.dLocal === undefined && s.modo === 'degradado');
        if (semMarca) { if (s.dadosEm) s.dadosEm = alinhar(s.dadosEm, null); s.dLocal = desvio(); mudou = true; }
        return mudou;
      }
      // depois de medir o desvio: compatibiliza o snapshot (e o estado) e avisa as outras abas (rev nova)
      function recalibrar() {
        var s = lsGet(kSnap(), null);
        if (s && normalizar(s)) { s.rev = novaRev(); lsSet(kSnap(), s); aplicar(s); }
      }
      function minutoDoDia() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
      function hora(unixS) { var d = new Date(unixS * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
      function fmtQuando(unix, now) {
        if (!unix) return 'sem prazo';
        var diff = unix - now, d = new Date(unix * 1000);
        if (diff < 0) { var m = Math.floor(-diff / 60); return m < 60 ? 'atrasada ' + m + 'min' : (m < 1440 ? 'atrasada ' + Math.floor(m / 60) + 'h' : 'atrasada ' + Math.floor(m / 1440) + 'd'); }
        return (new Date(now * 1000).toDateString() === d.toDateString() ? '' : pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ') + hora(unix);
      }
      function key(n) { return NS + '_' + n + '_' + state.sub + '_' + state.uid; }
      // snapshot e liderança são isolados por PERFIL (modo pedido: auto/sdr/closer) + versão do snapshot: trocar o
      // override ou atualizar o widget nunca reaproveita a fila de outro modo/regra
      var SNAP_V = 2;
      function perfil() { return (cfg().modo || 'auto') + '.v' + SNAP_V; }
      function perfilAtivo() { return state.perfil || perfil(); }
      function kSnap() { return 'snap.' + perfilAtivo(); }
      function kLider() { return 'lider.' + perfilAtivo(); }
      function snapValido(s) { return !!s && s.v === SNAP_V && s.perfil === perfilAtivo(); }
      function lsGet(n, d) { try { var v = localStorage.getItem(key(n)); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
      function lsSet(n, v) { try { localStorage.setItem(key(n), JSON.stringify(v)); } catch (e) {} }
      function vivo(g) { return !state.destruido && g === state.geracao; }
      function ativoParaEsteUsuario() { var u = cfg().usuarios; return !u.length || u.indexOf(String(state.uid)) !== -1; }
      function intervalo(fn, ms) { var h = setInterval(fn, ms); state.timers.push({ t: 'i', h: h }); return h; }
      function atraso(fn, ms) { var h = setTimeout(fn, ms); state.timers.push({ t: 't', h: h }); return h; }
      function ouvir(alvo, ev, fn, opt) { alvo.addEventListener(ev, fn, opt); state.ouvintes.push([alvo, ev, fn, opt]); }
      // notificações só com dados confirmados e recentes (< 3 ciclos, sem falha); AÇÕES com qualquer lista recebida
      // (decisão do Gabriel: dado velho não trava o trabalho — Concluir confere a tarefa ao vivo no Kommo)
      function dadosRecentes() { return !!state.dadosEm && (agoraS() - state.dadosEm) < cfg().poll * 3; }
      function podeAgir() { return !!state.dadosEm && (state.modo === 'servidor' || state.modo === 'degradado'); }

      // ---------------- navegação ----------------
      function seg(etype) { return { leads: 'leads', contacts: 'contacts', companies: 'companies', customers: 'customers' }[etype] || 'leads'; }
      function abrir(etype, eid) {
        var path = '/' + seg(etype) + '/detail/' + eid;
        try { if (window.AMOCRM && AMOCRM.Router && AMOCRM.Router.navigate) { AMOCRM.Router.navigate(path, { trigger: true }); return; } } catch (e) {}
        try { if (window.AMOCRM && AMOCRM.redirect) { AMOCRM.redirect(path); return; } } catch (e) {}
        window.location.href = location.origin + path;
      }
      function entidadeAtual() {
        var m = String(location.pathname).match(/\/(leads|contacts|companies|customers)\/detail\/(\d+)/);
        return m ? { etype: m[1], eid: parseInt(m[2], 10) } : null;
      }

      // ---------------- fonte 1: servidor (autoridade do que é emitido) ----------------
      function lerServidor(forcar, cb) {
        var c = cfg();
        if (!c.endpoint) { cb({ erro: 'sem_endpoint' }); return; }
        var req;
        try {
          req = self.$authorizedAjax({ url: c.endpoint, method: 'POST', contentType: 'application/json', dataType: 'json',
            data: JSON.stringify(c.modo ? { forcar: !!forcar, modo: c.modo } : { forcar: !!forcar }) });
        } catch (e) { cb({ erro: 'sem_authorizedAjax' }); return; }
        if (!req || typeof req.then !== 'function') { cb({ erro: 'sem_promessa' }); return; }
        req.then(function (r) {
          if (!r || !r.ok) { cb({ erro: 'resposta' }); return; }
          cb(null, r);
        }, function (x) {
          var j = (x && x.responseJSON) || {};
          if (cfg().debug_voz && window.console) { try { console.info('[ruston-prevendas][fila] servidor respondeu', x && x.status, j.erro || '', j.retry_after ? 'retry ' + j.retry_after + 's' : ''); } catch (e) {} }
          cb({ erro: j.erro || (x && x.status) || 'erro', retryAfter: j.retry_after || 0 });
        });
      }

      // ---------------- fonte 2 (degradada): API do Kommo pela sessão (autoritativa para o próprio usuário) ----
      function lerKommo(g, cb) {
        var todas = [], pagina = 1;
        function prox() {
          if (!vivo(g)) return;
          var url = '/api/v4/tasks?filter[responsible_user_id]=' + encodeURIComponent(state.uid) +
                    '&filter[is_completed]=0&order[complete_till]=asc&limit=250&page=' + pagina;
          $.ajax({ url: url, method: 'GET', dataType: 'json' })
            .done(function (data, ts, xhr) {
              if (!vivo(g)) return;
              var lote = (xhr && xhr.status === 204) ? [] : ((data && data._embedded && data._embedded.tasks) || []);
              todas = todas.concat(lote);
              if (lote.length === 250 && pagina < MAX_PAGINAS_DEGRADADO) { pagina++; atraso(prox, PASSO_PAGINA_MS); return; }
              cb(null, todas, lote.length === 250);
            })
            .fail(function (xhr) {
              if (!vivo(g)) return;
              var ra = parseInt(xhr && xhr.getResponseHeader && xhr.getResponseHeader('Retry-After'), 10);
              var st = (xhr && xhr.status) || 'erro';
              if (st === 429) pausar(isNaN(ra) ? 60 : ra);
              cb({ status: st }, todas, true);
            });
        }
        prox();
      }
      function deKommo(t, closer) {
        var k = Fila.classificarLocal(t);
        return { id: t.id, entity_type: t.entity_type || 'leads', entity_id: t.entity_id, due: t.complete_till || 0,
                 texto: t.text || '', lead_nome: null, etapa: null, momento: k.momento, grupo: k.grupo, urgente: k.urgente, acao: k.acao,
                 etapa_pendente: !!closer };   // closer sem servidor: etapa desconhecida → nível 8, agrupado por lead
      }

      // ---------------- ciclo (só a aba líder consulta) ----------------
      function pausar(seg) { lsSet('pausa', Date.now() + Math.min(600, Math.max(5, seg)) * 1000); }
      function pausado() { return Date.now() < (lsGet('pausa', 0) || 0); }

      // troca de perfil (override do modo mudou): invalida as leituras em voo, solta a liderança do perfil antigo e
      // recomeça SÓ com o estado do perfil novo
      function trocarPerfil() {
        var antigo = state.perfil, novo = perfil();
        if (!antigo || antigo === novo) return false;
        var l = lsGet('lider.' + antigo, null); if (l && l.aba === ABA) lsSet('lider.' + antigo, null);
        state.perfil = novo; state.carregando = false; state.rev = ''; state.itens = []; state.fila = []; state.futura = null; state.atual = null;
        state.dadosEm = 0; state.falha = null; state.modoConfirmado = ''; state.modoFila = 'sdr'; state.notif = []; state.chatsEm = 0; state.motivos = []; state.aviso = '';
        try { sessionStorage.removeItem(key('atual')); } catch (e) {}
        carregarSnapshot(); render();
        return true;
      }

      function ciclo(g, manual) {
        if (!vivo(g)) return;
        if (trocarPerfil()) manual = true;
        // watchdog: um pedido que nunca volta (token do Kommo/rede) não pode congelar a fila — depois de 45 s, segue
        if (state.carregando && Date.now() - state.carregandoEm < 45000) return;
        var p = state.perfil;
        var meu = function () { return vivo(g) && p === state.perfil && p === perfil(); };   // resposta de outro perfil é descartada
        if (pausado()) { if (manual) { state.aviso = 'O Kommo pediu uma pausa (limite de uso). Tento de novo em instantes.'; render(); } return; }
        var lock = lsGet(kLider(), null);
        if (!Fila.devoLiderar(lock, ABA, Date.now())) { carregarSnapshot(); return; }
        lsSet(kLider(), { aba: ABA, ate: Date.now() + cfg().poll * 2500 });
        state.carregando = true; state.carregandoEm = Date.now();
        if (manual) render();
        lerServidor(manual, function (err, r) {
          if (!meu()) return;
          try { tratar(err, r); } catch (e) { state.carregando = false; if (window.console) console.error('[ruston-prevendas] ciclo', e); }
        });
        function tratar(err, r) {
          if (!err) {
            var aviso = '', f = r.frescor_leads;
            if (f && (f.status !== 'done' || f.erro || (f.atraso_s != null && f.atraso_s > ATRASO_MAX_S))) aviso += 'Dados de lead (origem/etapa) atrasados; a ordem pode variar. ';
            if (r.origem_pendente) aviso += r.origem_pendente + ' tarefa(s) com origem ainda não consultada. ';
            if (r.em_andamento) reTentarLogo(g);           // outra aba/navegador está montando a lista: busca a nova em segundos
            medirDesvio(r.servidor_agora);                 // só ajusta o "agora"; os carimbos do servidor continuam brutos
            recalibrar();                                  // carimbos locais (falha/degradado) vão para o referencial novo
            if (!Fila.leituraMaisNova(r.gerado_em || 0, state.dadosEm)) { state.carregando = false; render(); return; }   // igual/anterior ao estado atual: ignora (mantém falha)
            if (r.retry_after) pausar(r.retry_after);   // o Kommo pediu pausa (ex.: 429 nos chats): a fila veio, mas a próxima leitura espera
            publicar({ itens: r.itens || [], modo: 'servidor', aviso: aviso.trim(), parcial: !!r.parcial, motivos: r.motivos_parcial || [], chatsEm: r.chats_em || 0, modoFila: r.modo === 'closer' ? 'closer' : 'sdr' }, r.gerado_em || 0, p);
            return;
          }
          if (err.erro === 'kommo_429') { pausar(err.retryAfter || 60); falhou('O Kommo pediu uma pausa (limite de uso).', p); return; }
          if (err.erro === 'ocupado' || err.erro === 'em_andamento') { pausar(err.retryAfter || 3); state.carregando = false; reTentarLogo(g); return; }   // transitório: tenta logo, sem degradar
          // servidor indisponível por outro motivo: lê as próprias tarefas pela sessão (autoritativo para o usuário)
          var inicio = { t: agoraS(), d: marca() };                   // instante e marca juntos, no início
          lerKommo(g, function (e2, lista, parcial) {
            if (!meu()) return;
            var lidoEm = alinhar(inicio.t, inicio.d), marcaLida = inicio.d === null && calibrado() ? desvio() : inicio.d;   // outra aba pode ter calibrado no meio
            if (!e2 || lista.length) { if (!Fila.leituraMaisNova(lidoEm, state.dadosEm)) { state.carregando = false; render(); return; } }
            if (e2 && !lista.length) { falhou('Não consegui atualizar a fila (' + err.erro + ' / ' + e2.status + ').', p); return; }
            // mantém o ÚLTIMO modo confirmado pelo servidor; sem nenhum, diz isso e mostra como SDR
            var mf = state.modoConfirmado === 'closer' || state.modoConfirmado === 'sdr' ? state.modoConfirmado : '';
            publicar({ itens: lista.map(function (t) { return deKommo(t, mf === 'closer'); }), modo: 'degradado', modoFila: mf,
                       aviso: 'Classificação indisponível (' + err.erro + '): ordem só por vencimento.' + (e2 ? ' Leitura parcial (' + e2.status + ').' : '') +
                              (mf ? '' : ' Modo da fila ainda não confirmado pelo servidor: mostrando como SDR.'), parcial: parcial }, lidoEm, p, marcaLida);
          });
        }
      }
      // uma nova tentativa ~7 s depois (fora do ciclo normal), no máximo uma agendada por vez
      function reTentarLogo(g) {
        if (state.reTentar) return;
        state.reTentar = atraso(function () { state.reTentar = 0; ciclo(g, false); }, 7000);
      }

      function novaRev() { return Date.now().toString(36) + '.' + Math.random().toString(36).slice(2, 7); }
      // sucesso: dadosEm = momento REAL da leitura (gerado_em do servidor; agora no degradado, que lê ao vivo)
      function publicar(snap, lidoEm, p, marcaLocal) {
        if (p !== state.perfil) return;                            // leitura de outro perfil: descarta
        snap.rev = novaRev(); snap.dadosEm = lidoEm || agoraS();
        if (marcaLocal !== undefined) snap.dLocal = marcaLocal;    // carimbo feito no navegador (degradado): número ou null
        snap.falha = Fila.falhaApos(state.falha, snap.dadosEm);   // cache de antes da falha não comprova recuperação
        state.carregando = false;
        snap.v = SNAP_V; snap.perfil = p;
        lsSet(kSnap(), snap); aplicar(snap);
        if (dadosRecentes() && !state.falha) notificar(true); else state.notif = [];
        render();
      }
      // falha: mantém os dados antigos (e a idade real), registra e propaga; ações ficam suspensas
      function falhou(msg, p) {
        if (p !== state.perfil) return;
        var s0 = lsGet(kSnap(), null), s = snapValido(s0) ? s0 : { itens: [], modo: state.modo, aviso: '', dadosEm: 0, modoFila: '', v: SNAP_V, perfil: p };
        s.rev = novaRev(); s.falha = { em: agoraS(), msg: msg, d: marca() };
        state.carregando = false;
        lsSet(kSnap(), s); aplicar(s); render();
      }
      function mutar(fn) {
        var s = lsGet(kSnap(), null);
        if (!snapValido(s)) return;
        fn(s); s.rev = novaRev();
        lsSet(kSnap(), s); aplicar(s);
      }
      function carregarSnapshot() {
        var s = lsGet(kSnap(), null);
        if (snapValido(s) && s.rev !== state.rev) { aplicar(s); if (dadosRecentes() && !state.falha) notificar(false); else state.notif = []; render(); }
      }
      function aplicar(s) {
        normalizar(s);                                             // snapshot de outra aba/sessão: mesmo referencial
        state.rev = s.rev || ''; state.modo = s.modo; state.aviso = s.aviso || ''; state.parcial = !!s.parcial;
        state.dadosEm = s.dadosEm || 0; state.falha = s.falha || null; state.chatsEm = s.chatsEm || 0; state.modoFila = s.modoFila === 'closer' ? 'closer' : 'sdr'; state.modoConfirmado = s.modoFila || '';
        state.itens = s.itens || []; state.motivos = s.motivos || [];
        montar();
      }

      // ---------------- montagem ----------------
      function paraQ(t) {
        return { id: t.id, due: t.due || 0, momento: t.momento, grupo: t.grupo || 'G9', urgente: !!t.urgente, acao: t.acao,
                 etype: t.entity_type || 'leads', eid: t.entity_id, texto: t.texto || '', nome: t.lead_nome, etapa: t.etapa, origemPendente: !!t.origem_pendente,
                 status_id: t.status_id, pipeline_id: t.pipeline_id, etapa_pendente: !!t.etapa_pendente, reuniao_em: t.reuniao_em || 0 };
      }
      function montar() {
        var now = agoraS(), snooze = lsGet('snooze', {}), marcas = lsGet('marcas', {});
        var closer = state.modoFila === 'closer', agoraMs = Date.now();
        var ent = function (t) { return 'E:' + (t.entity_type || 'leads') + ':' + t.entity_id; };
        var ok = function (t) {
          if (!t || !t.entity_id || (snooze[t.id] && snooze[t.id] > now)) return false;
          if (closer && ((snooze[ent(t)] && snooze[ent(t)] > now) || (marcas[ent(t)] && agoraMs - marcas[ent(t)] < MARCA_TTL_MS))) return false;   // lead concluído/pulado agora
          return true;
        };
        var validos = Fila.semChatsVencidos(state.itens, state.chatsEm, now, CHATS_MAX_S);
        state.chatsVencidos = validos.length !== state.itens.length;
        var itens = Fila.semMarcadas(validos, marcas, Date.now(), MARCA_TTL_MS).filter(ok).map(paraQ);
        var c = cfg(), r = closer
          ? Fila.ordenarCloser(itens, { etapas: c.etapas_closer, antecedencia_closer_min: c.antecedencia_closer_min, lookahead: c.lookahead }, now)
          : Fila.ordenar(itens, { antecedencia_min: c.antecedencia_min, grupos: c.grupos }, now, minutoDoDia());
        state.fila = r.fila; state.futura = r.futura;
        if (state.atual) {
          var alvo = state.atual.id, alvoEnt = Fila.chaveEnt(state.atual), novo = null;
          state.fila.concat(state.futura ? [state.futura] : []).forEach(function (q) {
            if (closer ? Fila.chaveEnt(q) === alvoEnt : q.id === alvo) novo = novo || q;   // closer: mesma entidade, nova representativa
          });
          state.atual = novo;     // fora do que foi confirmado: o card some
        }
      }

      // ---------------- notify (só sobre itens confirmados) ----------------
      // Expiração dos chats pelo RELÓGIO (não depende de leitura nova nem de rev nova do snapshot): tira chat vencido da
      // fila, do card atual e das notificações; tarefas, dadosEm e falha ficam como estão. Chamado a cada tique,
      // antes de renderizar e antes de navegar — inclusive durante pausa e em aba seguidora.
      function ehChat(q) { return !!q && q.momento === 'chat_sem_resposta'; }
      function podarChats() {
        if (state.chatsEm && agoraS() - state.chatsEm <= CHATS_MAX_S) return false;
        var tem = state.fila.some(ehChat) || ehChat(state.futura) || ehChat(state.atual) || state.notif.some(ehChat);
        if (!tem) return false;
        state.notif = state.notif.filter(function (n) { return !ehChat(n); });
        if (ehChat(state.atual)) { state.atual = null; try { sessionStorage.removeItem(key('atual')); } catch (e) {} }
        montar();                                   // refiltra pela validade (semChatsVencidos) e recalcula a fila
        return true;
      }

      function notificar(souLider) {
        var c = cfg(), now = agoraS();
        var base = Fila.semChatsVencidos(state.itens, state.chatsEm, now, CHATS_MAX_S);
        var r = Fila.paraNotificar(base, lsGet('visto', {}), now, c.lookahead, MAX_NOTIF_CICLO);
        var abertas = {}; base.forEach(function (t) { abertas[t.id] = 1; });
        var pilha = lsGet('notif', []).filter(function (n) { return abertas[n.id]; });
        if (souLider) {
          r.mostrar.forEach(function (t) {
            pilha.unshift({ id: t.id, titulo: t.texto || 'Tarefa', etype: t.entity_type || 'leads', eid: t.entity_id, due: t.due, momento: t.momento });
            try {
              if (window.Notification && Notification.permission === 'granted') {
                var no = new Notification(t.texto || 'Tarefa', { body: t.due < now ? 'Atrasada' : 'Vence em breve', icon: state.base ? state.base + '/images/icon.png' : undefined, tag: NS + '-' + t.id });
                no.onclick = function () { window.focus(); abrir(t.entity_type || 'leads', t.entity_id); no.close(); };
              }
            } catch (e) {}
          });
          var vistosIds = {}; pilha = pilha.filter(function (n) { if (vistosIds[n.id]) return false; vistosIds[n.id] = 1; return true; });
          if (r.mostrar.length) som();
          lsSet('visto', r.visto); state.resumoNotif = r.resumidas; lsSet('notif', pilha.slice(0, 8));
        }
        state.notif = pilha.slice(0, 8);
      }
      function initAudio() { if (state.audio || !state.base) return; try { state.audio = new Audio(state.base + '/notify.mp3'); state.audio.preload = 'auto'; } catch (e) {} }
      function som() { if (!cfg().sound || !state.audio) return; try { state.audio.currentTime = 0; var p = state.audio.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} }

      // ---------------- ações (só com dados confirmados e recentes) ----------------
      function concluirEProximo(q) {
        if (!q || !podeAgir() || q.id < 0) { render(); return; }   // id < 0 = chat sem resposta (não é tarefa)
        var g = state.geracao;
        // a lista pode estar velha: confere a tarefa AO VIVO (aberta e do usuário) antes de concluir
        $.ajax({ url: '/api/v4/tasks/' + encodeURIComponent(q.id), method: 'GET', dataType: 'json' })
          .done(function (t) {
            if (!vivo(g)) return;
            // só conclui se o envelope vivo confirmar TUDO: mesma tarefa, aberta, do usuário e do MESMO lead/contato do
            // card; envelope incompleto ou diferente = não conclui (o card sai; a próxima leitura traz o estado real)
            var motivo = t && Number(t.id) === Number(q.id) && t.is_completed === true ? 'concluída'
              : !t || Number(t.id) !== Number(q.id) || t.is_completed !== false || t.responsible_user_id == null || t.entity_type == null || t.entity_id == null ? 'não pôde ser conferida'
              : Number(t.responsible_user_id) !== Number(state.uid) ? 'com outra pessoa'
              : String(t.entity_type) !== String(q.etype) || Number(t.entity_id) !== Number(q.eid) ? 'vinculada a outro registro' : '';
            if (motivo) {
              mutar(function (s) { s.itens = (s.itens || []).filter(function (x) { return x.id !== q.id; }); });
              state.aviso = 'Essa tarefa ' + (motivo === 'não pôde ser conferida' ? motivo : 'já estava ' + motivo) + ' no Kommo; não concluí e segui para a próxima.';
              state.atual = null; montar(); avancar(); return;
            }
            concluirAgora(q, g);
          })
          .fail(function (x) {
            if (!vivo(g)) return;
            if (x && x.status === 404) { mutar(function (s) { s.itens = (s.itens || []).filter(function (y) { return y.id !== q.id; }); }); state.atual = null; montar(); avancar(); return; }
            alert('Não consegui conferir a tarefa no Kommo (' + ((x && x.status) || 'erro') + ').');
          });
      }
      function concluirAgora(q, g) {
        $.ajax({ url: '/api/v4/tasks/' + encodeURIComponent(q.id), method: 'PATCH', contentType: 'application/json', dataType: 'json',
                 data: JSON.stringify({ is_completed: true, result: { text: 'Concluída pelo PRÓXIMO' } }) })
          .done(function () {
            if (!vivo(g)) return;
            var m = lsGet('marcas', {}), agora = Date.now();
            Object.keys(m).forEach(function (k) { if (agora - m[k] >= MARCA_TTL_MS) delete m[k]; });
            m[q.id] = agora;
            if (state.modoFila === 'closer') m['E:' + q.etype + ':' + q.eid] = agora;   // closer: o próximo é outro LEAD
            lsSet('marcas', m);
            mutar(function (s) { s.itens = (s.itens || []).filter(function (t) { return t.id !== q.id; }); });
            state.atual = null; montar(); avancar();
            ciclo(g, true);   // pede a próxima leva já conferida (forcar respeita o mínimo de 5 s no servidor)
          })
          .fail(function (x) { if (vivo(g)) alert('Não consegui concluir a tarefa (' + ((x && x.status) || 'erro') + ').'); });
      }
      function pular(q) {
        if (!q) return;
        var s = lsGet('snooze', {}), now = agoraS();
        Object.keys(s).forEach(function (k) { if (s[k] <= now) delete s[k]; });
        s[q.id] = now + 15 * 60;
        if (state.modoFila === 'closer') s['E:' + q.etype + ':' + q.eid] = now + 15 * 60;
        lsSet('snooze', s);
        state.atual = null; montar(); avancar();
      }
      function avancar() {
        podarChats();
        if (!podeAgir()) { render(); return; }
        var p = Fila.proximoDe(state.fila, state.futura, entidadeAtual());
        if (!p) { render(); return; }
        state.atual = p.item;
        try { sessionStorage.setItem(key('atual'), JSON.stringify(p.item)); } catch (e) {}
        abrir(p.item.etype, p.item.eid);
        render();
      }

      // ---------------- telefone (webphone 4com) ----------------
      function endpointVoz() { var c = cfg(); return c.endpoint_voz || (c.endpoint ? c.endpoint.replace(/prevendas-fila\/?$/, 'prevendas-voz') : ''); }
      function chamarVoz(corpo, cb) {
        var url = endpointVoz();
        if (!url) { cb({ erro: 'nao_configurado' }); return; }
        var req, pv = cfg().provedor_voz;
        if (pv) corpo.provedor = pv;                                  // o servidor confere se o usuário tem esse provedor
        try { req = self.$authorizedAjax({ url: url, method: 'POST', contentType: 'application/json', dataType: 'json', data: JSON.stringify(corpo) }); }
        catch (e) { cb({ erro: 'sem_authorizedAjax' }); return; }
        if (!req || typeof req.then !== 'function') { cb({ erro: 'sem_promessa' }); return; }
        req.then(function (r) { if (!r || !r.ok) { cb({ erro: (r && r.erro) || 'resposta' }); return; } cb(null, r); },
                 function (x) { var j = (x && x.responseJSON) || {}; cb({ erro: j.erro || (x && x.status) || 'erro', mensagem: j.mensagem || '', incerto: !!j.incerto }); });
      }
      // posse do ramal entre abas: Web Locks (exclusão real; "usar aqui" rouba com steal). Sem Web Locks: não registra.
      function travas() { try { return (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) ? navigator.locks : null; } catch (e) { return null; } }
      function nomeTrava() { return NS + '-voz-' + state.sub + '-' + state.uid; }
      function tenho(tok, g) { return vivo(g) && cfg().voz && voz.posse === tok; }
      function carregarJsSIP(cb) {
        if (window.JsSIP && window.JsSIP.UA) { cb(null); return; }
        if (!state.base) { cb('sem_base'); return; }
        var sc = document.createElement('script');
        sc.src = state.base + '/jssip.min.js'; sc.async = true;
        sc.onload = function () { cb(window.JsSIP && window.JsSIP.UA ? null : 'jssip_ausente'); };
        sc.onerror = function () { cb('jssip_falhou'); };
        document.head.appendChild(sc);
      }
      function audioEl() {
        var a = document.getElementById(NS + '-audio');
        if (!a) { a = document.createElement('audio'); a.id = NS + '-audio'; a.autoplay = true; document.body.appendChild(a); }
        return a;
      }
      function vozEstado(e, msg) { voz.estado = e; voz.msg = msg || ''; render(); }
      function iniciarVoz(g, roubar) {
        if (!cfg().voz || voz.posse || voz.pedindo) return;
        var L = travas();
        if (!L) { vozEstado('erro', 'Este navegador não controla abas para o telefone; use o Chrome atualizado.'); return; }
        var tok = ++posseSeq; voz.pedindo = tok; voz.provedorPedido = cfg().provedor_voz; vozEstado('carregando');
        var p;
        try {
          p = L.request(nomeTrava(), roubar ? { steal: true } : { ifAvailable: true }, function (lock) {
            if (voz.pedindo === tok) voz.pedindo = 0;
            if (!lock) { if (vivo(g) && tok === posseSeq) vozEstado('outra_aba'); return; }
            if (!vivo(g) || !cfg().voz || tok !== posseSeq) return;            // pedido superado: solta na hora
            voz.posse = tok;
            return new Promise(function (soltar) { voz.soltar = soltar; comPosse(tok, g); });
          });
        } catch (e) { voz.pedindo = 0; vozEstado('erro', 'Falha ao reservar o telefone nesta aba.'); return; }
        if (p && p.catch) p.catch(function () {                                // posse roubada por outra aba (AbortError)
          if (voz.pedindo === tok) voz.pedindo = 0;
          if (voz.posse === tok) { pararVoz(); if (vivo(g)) vozEstado('outra_aba'); }
        });
      }
      function comPosse(tok, g) {
        carregarJsSIP(function (e) {
          if (!tenho(tok, g)) return;
          if (e) { vozEstado('erro', 'Não consegui carregar o telefone (' + e + ').'); return; }
          try { if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) { st.getTracks().forEach(function (t) { t.stop(); }); }, function () { if (tenho(tok, g)) vozEstado('erro', 'Permita o microfone para este site (cadeado na barra de endereço).'); }); } catch (x) {}
          chamarVoz({ acao: 'credencial' }, function (err, c) {
            if (!tenho(tok, g)) return;                                        // posse perdida durante o pedido: descarta
            if (err) { vozEstado('erro', Fila.mensagemVoz(err.erro)); return; }
            criarUA(c, tok, g); c = null;                                      // a credencial só vive na config do UA
          });
        });
      }
      function criarUA(c, tok, g) {
        var ua;
        try {
          ua = new window.JsSIP.UA({
            sockets: [new window.JsSIP.WebSocketInterface(c.wss)], uri: c.uri, authorization_user: c.ramal,
            ha1: c.ha1, realm: c.realm, display_name: c.nome, register: true, register_expires: 300,
            session_timers: false, no_answer_timeout: 30
          });
        } catch (e) { vozEstado('erro', 'Configuração do telefone inválida.'); return; }
        var meu = function () { return tenho(tok, g) && voz.ua === ua; };
        voz.ua = ua; voz.provedor = c.provedor === '3c' ? '3c' : '4com';
        var dbg = function () { if (!cfg().debug_voz || !window.console) return; try { console.info.apply(console, ['[ruston-prevendas][voz]'].concat([].slice.call(arguments))); } catch (e) {} };
        ua.on('connected', function () { dbg('WSS conectado'); });
        ua.on('registered', function (e) {
          try { var r = e && e.response; dbg('REGISTRADO', r && r.status_code, 'Contact:', r && r.getHeader('Contact'), 'Expires:', r && r.getHeader('Expires')); } catch (x) {}
          var outros = 0;
          try { var hs = e && e.response && (e.response.getHeaders ? e.response.getHeaders('Contact') : [e.response.getHeader('Contact')]); outros = Fila.contarRegistros(hs) - 1; } catch (x) {}
          if (meu() && voz.aposRegistro) { var seguir = voz.aposRegistro; voz.aposRegistro = null; seguir(); }
          if (meu()) vozEstado('registrado', outros > 0 ? 'Este ramal também está registrado em outro lugar (webphone/app/extensão do provedor). Feche os outros, senão as ligações podem tocar lá e não aqui.' : '');
        });
        ua.on('unregistered', function () { if (meu()) vozEstado('reconectando'); });
        ua.on('registrationFailed', function (e) { dbg('REGISTRO FALHOU', e && e.cause, e && e.response && e.response.status_code); if (meu()) vozEstado('erro', 'O ramal não registrou (' + ((e && e.cause) || 'falha') + ').'); });
        ua.on('disconnected', function (e) { dbg('WSS desconectado', e && e.code, e && e.reason); if (meu() && voz.estado === 'registrado') vozEstado('reconectando'); });
        ua.on('newRTCSession', function (ev) {
          if (ev.originator !== 'remote') return;
          var s = ev.session;
          try { var q = ev.request; dbg('INVITE recebido', q && q.ruri && String(q.ruri), 'de', q && q.from && String(q.from.uri), 'integrada:', q && q.getHeader('X-Api4comintegratedcall'), 'pendente:', voz.pendenteAte > mono()); } catch (x) {}
          if (!meu() || voz.sessao) { try { s.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); } catch (e) {} return; }
          var integ = false;
          // chamada integrada (a que o servidor pediu ao provedor): a 4com marca com o header X-Api4comintegratedcall;
          // no 3C ela vem do usuário 3cplus (o mesmo critério do webphone do próprio 3C)
          try {
            integ = voz.provedor === '3c'
              ? String((ev.request.from && ev.request.from.uri && ev.request.from.uri.user) || '') === '3cplus'
              : String(ev.request.getHeader('X-Api4comintegratedcall') || '').toLowerCase() === 'true';
          } catch (e) {}
          try { if (window.console) console.info('[ruston-prevendas] INVITE recebido; cabeçalhos:', Object.keys((ev.request && ev.request.headers) || {}).join(',')); } catch (e) {}
          voz.sessao = s; voz.tocando = true; voz.emChamada = false; voz.mudo = false; voz.orientacao = -1;
          voz.pedida = Fila.chamadaPedida(integ, voz.pendenteAte, mono());
          var t0 = mono(), ms = function () { return Math.round(mono() - t0) + ' ms'; };
          s.on('peerconnection', function (pe) {
            try { pe.peerconnection.addEventListener('icegatheringstatechange', function () { dbg('ICE gathering', pe.peerconnection.iceGatheringState, ms()); }); } catch (x) {}
            try { pe.peerconnection.addEventListener('iceconnectionstatechange', function () { dbg('ICE conexão', pe.peerconnection.iceConnectionState, ms()); }); } catch (x) {}
            pe.peerconnection.addEventListener('track', function (te) { if (voz.sessao !== s) return; var a = audioEl(); a.srcObject = (te.streams && te.streams[0]) || null; var p = a.play && a.play(); if (p && p.catch) p.catch(function () {}); });
          });
          s.on('confirmed', function () { dbg('ACK recebido (chamada confirmada)', ms()); });
          s.on('accepted', function () { dbg('200 OK enviado (aguardando ACK)', ms()); if (voz.sessao !== s) return; voz.tocando = false; voz.emChamada = true; voz.inicio = Date.now(); voz.aviso = ''; render(); });
          var daTentativa = voz.pedida;                                     // só a chamada da tentativa encerra a janela dela
          var fim = function (e) { if (voz.sessao !== s) return; voz.sessao = null; voz.tocando = false; voz.emChamada = false; if (daTentativa) voz.pendenteAte = 0; voz.pedida = false;
                                   voz.aviso = e && e.cause && e.cause !== 'Terminated' && e.cause !== 'Canceled' ? 'Chamada encerrada (' + e.cause + ').' : 'Chamada encerrada.';
                                   if (voz.resEv) agendarResultado(g, voz.resEv, 8000, true); render(); };
          s.on('ended', function (e) { dbg('encerrada por', e && e.originator, e && e.cause, ms()); fim(e); });
          s.on('failed', function (e) { dbg('chamada falhou', e && e.cause, 'por', e && e.originator, (e && e.message && e.message.status_code) || '', ms()); fim(e); });
          if (Fila.deveAtender(integ, voz.pendenteAte, mono(), voz.atendidaNaTentativa === voz.tentativa)) {
            voz.atendidaNaTentativa = voz.tentativa;                          // consome a autorização desta tentativa
            dbg('atendendo automaticamente (tentativa ' + voz.tentativa + ')', ms());
            atenderVoz();
          } else { som(); render(); }                                          // fora da tentativa: toca e espera o clique
        });
        if (!meu()) { try { ua.stop(); } catch (e) {} voz.ua = null; return; }
        ua.start();
      }
      function atenderVoz() { if (!voz.sessao || voz.emChamada) return; try { voz.sessao.answer({ mediaConstraints: { audio: true, video: false } }); } catch (e) { voz.aviso = 'Não consegui atender.'; } render(); }
      function desligarVoz() { if (!voz.sessao) return; try { voz.sessao.terminate(); } catch (e) {} }
      function mudoVoz() { if (!voz.sessao || !voz.emChamada) return; try { if (voz.mudo) voz.sessao.unmute(); else voz.sessao.mute(); voz.mudo = !voz.mudo; } catch (e) {} render(); }
      // desliga tudo e invalida qualquer passo assíncrono em voo (credencial atrasada, eventos do UA)
      function pararVoz() {
        posseSeq++;
        var sess = voz.sessao, ua = voz.ua, soltar = voz.soltar;
        voz.sessao = null; voz.ua = null; voz.soltar = null; voz.posse = 0; voz.pedindo = 0;
        voz.tocando = false; voz.emChamada = false; voz.pendenteAte = 0; voz.discando = false; voz.pedida = false; voz.tentativa++; voz.orientacao = -1;
        try { if (sess) sess.terminate(); } catch (e) {}
        try { if (ua) ua.stop(); } catch (e) {}
        try { if (soltar) soltar(); } catch (e) {}
        try { var a = document.getElementById(NS + '-audio'); if (a) a.srcObject = null; } catch (e) {}
      }
      // a cada 1 s: voz=N derruba o ramal; voz=Y sem posse tenta assumir (aba ocupada: a cada 5 s, sem roubar)
      function cicloVoz(g) {
        if (!vivo(g)) return;
        if (!cfg().voz) {
          if (voz.posse || voz.pedindo || voz.ua || voz.estado !== 'off') { pararVoz(); voz.estado = 'off'; voz.msg = ''; voz.aviso = ''; render(); }
          return;
        }
        if ((voz.posse || voz.pedindo) && (voz.provedorPedido || '') !== cfg().provedor_voz) { pararVoz(); voz.estado = 'off'; voz.msg = ''; render(); return; }   // trocou o provedor: solta agora, registra no próximo tique (a trava solta é assíncrona)
        if (!voz.posse && !voz.pedindo && (voz.estado === 'off' || (voz.estado === 'outra_aba' && (++voz.espera % 5 === 0)))) iniciarVoz(g, false);
        if (voz.estado === 'registrado') telefonesAqui(g);
        if (voz.emChamada) render();
      }
      function usarAqui(g) { pararVoz(); voz.estado = 'off'; iniciarVoz(g, true); }
      function telefonesAqui(g) {
        var aqui = entidadeAtual();
        if (!aqui || (aqui.etype !== 'leads' && aqui.etype !== 'contacts')) { voz.tel = { chave: '', contatos: null, erro: '', carregando: false }; return; }
        var chave = aqui.etype + ':' + aqui.eid;
        if (voz.tel.chave === chave) return;
        voz.tel = { chave: chave, contatos: null, erro: '', carregando: true };
        chamarVoz({ acao: 'telefones', entity_type: aqui.etype, entity_id: aqui.eid }, function (err, r) {
          if (!vivo(g) || voz.tel.chave !== chave) return;
          voz.tel.carregando = false;
          if (err) voz.tel.erro = Fila.mensagemVoz(err.erro); else { voz.tel.contatos = r.contatos || []; voz.tel.teste = r.teste || []; }
          render();
        });
      }
      function discarVoz(tel, manual) {
        var aqui = entidadeAtual();
        // nova tentativa SUBSTITUI a pendente (a resposta antiga é ignorada pelo número da tentativa); só não disca em
        // chamada; anti duplo clique de 1 s (o servidor também recusa pedidos a menos de 2 s)
        if ((!aqui && !manual) || voz.estado !== 'registrado' || voz.sessao || !tel) { render(); return; }
        if (mono() - voz.ultimoPedido < 1000) return;
        voz.ultimoPedido = mono();
        var t = ++voz.tentativa, posse = voz.posse;
        voz.discando = true; voz.aviso = 'Chamando… conectando o seu ramal aqui e depois ligando para o cliente.';
        voz.orientacao = -1;                                              // tentativa nova: limpa a orientação anterior
        atraso(function () {                                              // nada chegou em 25 s: orienta (registro duplicado é a causa mais comum)
          if (voz.tentativa === t && !voz.sessao && voz.pendenteAte > mono()) { voz.orientacao = t; render(); }
        }, 25000);
        voz.pendenteAte = mono() + 60000;                           // janela de 60 s no relógio monotônico
        render();
        var pedido = { acao: 'discar', telefone: tel };
        if (aqui && (aqui.etype === 'leads' || aqui.etype === 'contacts')) { pedido.entity_type = aqui.etype; pedido.entity_id = aqui.eid; }
        if (manual) pedido.manual = true;
        // a 4com entrega a chamada ao ÚLTIMO registro do ramal: re-registra agora e só então pede a discagem
        // (confirmação do REGISTER ou, no máximo, 2,5 s depois)
        var feito = false, pedir = function () {
          if (feito || t !== voz.tentativa || posse !== voz.posse) return;
          feito = true; voz.aposRegistro = null;
          if (voz.sessao || voz.estado !== 'registrado') {                  // ficou ocupado/sem ramal durante a espera: cancela
            voz.discando = false; voz.pendenteAte = 0; voz.orientacao = -1;
            voz.aviso = voz.sessao ? 'Ligação cancelada: você já está em outra chamada.' : 'Ligação cancelada: o telefone não está pronto.'; render(); return;
          }
          enviar();
        };
        voz.aposRegistro = pedir;
        try { if (voz.ua && voz.ua.register) voz.ua.register(); else pedir(); } catch (e) { pedir(); }
        atraso(pedir, 2500);
        function enviar() {
        chamarVoz(pedido, function (err, r) {
          if (t !== voz.tentativa || posse !== voz.posse) return;          // resposta de tentativa/posse antiga: ignora
          voz.discando = false;
          if (err) { voz.pendenteAte = 0; voz.orientacao = -1; if (voz.sessao && !voz.emChamada) voz.pedida = false; voz.aviso = err.erro === 'provedor_recusou' && /has been failed/i.test(String(err.mensagem || ''))
            ? 'A ligação não completou: a 4com entregou a chamada a outro registro do seu ramal (extensão/webphone/app da 4com). Tente de novo — o widget retoma o ramal.'
            : err.mensagem && /^provedor_/.test(err.erro) ? String(err.mensagem) : Fila.mensagemVoz(err.erro); }   // a mensagem do servidor é a mais precisa (ex.: nenhuma ligação foi feita)
          else if (!voz.sessao) voz.aviso = '';
          if (!err && r && r.ev && r.provedor === '4com') { voz.resEv = r.ev; voz.resTent = 0; agendarResultado(state.geracao, r.ev, 90000, false); }
          render();
        });
        }
      }
      // resultado final da ligação (CDR da 4com, pelo servidor; ele também atualiza a nota no Kommo). Uma cadeia de
      // consultas por ligação (a mais nova vence); 'pendente' tenta de novo com espera crescente, até 7 vezes (~17 min,
      // além dos 15 min do 'sem registro'). Sem aba aberta, o cron do servidor completa a nota do mesmo jeito.
      function agendarResultado(g, ev, ms, reinicia) {
        if (reinicia) voz.resTent = 0;
        var seq = ++voz.resSeq;
        atraso(function () {
          if (!vivo(g) || seq !== voz.resSeq || ev !== voz.resEv) return;
          chamarVoz({ acao: 'resultado', ev: ev }, function (err, r) {
            if (!vivo(g) || seq !== voz.resSeq || ev !== voz.resEv) return;
            var p = !err && r && r.pedido;
            if (p && !p.pendente && p.rotulo) {
              voz.resEv = 0;
              if (!voz.sessao) { voz.aviso = 'Última ligação: ' + p.rotulo + (p.rotulo === 'atendida' && p.duracao ? ' · ' + mmss(p.duracao * 1000) : '') + (p.nota ? ' (registrada no Kommo)' : ''); render(); }
              return;
            }
            if (++voz.resTent < 7) agendarResultado(g, ev, [20000, 40000, 60000, 120000, 300000, 420000][Math.min(voz.resTent - 1, 5)], false);
          });
        }, ms);
      }
      function mmss(ms) { var t = Math.max(0, Math.floor(ms / 1000)); return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
      var VOZ_POS_CHAMADA_MS = 20000;
      function vozEmUso() { return !!(voz.sessao || voz.pedida || voz.discando || voz.emChamada); }
      function vozVisivel() {
        if (vozEmUso()) { state.vozAte = Date.now() + VOZ_POS_CHAMADA_MS; return true; }
        return state.vozAberta || Date.now() < (state.vozAte || 0);
      }
      function htmlVoz() {
        if (!cfg().voz) return '';
        if (!vozVisivel()) return '';
        var rot = { off: 'desligado', carregando: 'conectando…', registrado: 'pronto', reconectando: 'reconectando…', erro: 'com problema', outra_aba: 'ativo em outra aba' }[voz.estado] || voz.estado;
        var h = '<div class="rpv-card"><div class="rpv-h"><span class="tt">📞 Telefone' + (voz.provedor && voz.ua ? ' ' + (voz.provedor === '3c' ? '3C' : '4com') : '') + ' · ' + esc(rot) + '</span>' +
                (voz.estado === 'outra_aba' ? '<button data-act="voz-aqui" title="Usar o telefone nesta aba">usar aqui</button>' : '') +
                (voz.estado === 'erro' ? '<button data-act="voz-reconectar" title="Tentar de novo">↻</button>' : '') + '</div>';
        if (voz.msg) h += '<div class="rpv-warn">' + esc(voz.msg) + '</div>';
        if (voz.sessao) {
          h += '<div class="rpv-b"><div class="nm">' + (voz.emChamada ? 'Em chamada · ' + mmss(Date.now() - voz.inicio) : (voz.pedida ? 'Sua ligação: atenda para falar com o cliente' : 'Chamada recebida')) + '</div></div><div class="rpv-acts">' +
               (voz.emChamada ? '<button data-act="voz-mudo">' + (voz.mudo ? 'Reativar mic' : 'Mudo') + '</button>' : '<button class="pri" data-act="voz-atender">Atender</button>') +
               '<button data-act="voz-desligar">' + (voz.emChamada ? 'Desligar' : 'Recusar') + '</button></div>';
        } else if (voz.estado === 'registrado' && voz.tel.chave) {
          if (voz.tel.carregando) h += '<div class="rpv-b">Buscando telefones…</div>';
          else if (voz.tel.erro) h += '<div class="rpv-warn">' + esc(voz.tel.erro) + '</div>';
          else {
            var n = 0;
            (voz.tel.contatos || []).forEach(function (c) {
              c.telefones.forEach(function (t) {
                n++;
                h += '<div class="rpv-it"><span class="bd"><div class="nm">' + esc(c.nome || 'Contato') + '</div><div class="mt">' + esc(t.exibir) + '</div></span>' +
                     '<button class="rpv-ligar" data-act="voz-ligar" data-tel="' + esc(t.e164) + '">Ligar</button></div>';
              });
            });
            var inval = 0; (voz.tel.contatos || []).forEach(function (c) { inval += c.invalidos || 0; });
            if (!n) h += '<div class="rpv-b">' + (inval ? 'Os ' + inval + ' telefone(s) dos contatos deste lead estão num formato que não reconheço.' : 'Nenhum telefone nos contatos deste lead.') + '</div>';
            else if (inval) h += '<div class="rpv-f"><span>+' + inval + ' telefone(s) em formato não reconhecido.</span></div>';
            (voz.tel.teste || []).forEach(function (t) {
              h += '<div class="rpv-it"><span class="bd"><div class="nm">Número de TESTE</div><div class="mt">' + esc(t) + '</div></span>' +
                   '<button class="rpv-ligar" data-act="voz-ligar" data-tel="' + esc(t) + '">Ligar</button></div>';
            });
          }
        }
        if (voz.estado === 'registrado' && !voz.sessao) {
          h += '<div class="rpv-it"><span class="bd"><input id="' + NS + '-manual" class="rpv-num" type="tel" inputmode="tel" placeholder="Digitar número (DDD + número)" value="' + esc(voz.manual) + '"></span>' +
               '<button class="rpv-ligar" data-act="voz-manual">Ligar</button></div>';
        }
        if (voz.orientacao === voz.tentativa && !voz.sessao) h += '<div class="rpv-warn">A ligação não chegou a este telefone. Se o webphone/app do provedor estiver aberto, feche-o e tente de novo.</div>';
        if (voz.aviso) h += '<div class="rpv-f"><span>' + esc(voz.aviso) + '</span></div>';
        return h + '</div>';
      }

      // ---------------- render ----------------
      var CSS = '' +
'.rpv-root{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}' +
'.rpv-root>*{pointer-events:auto}.rpv-bottom-right,.rpv-top-right{right:16px;align-items:flex-end}.rpv-bottom-left,.rpv-top-left{left:16px;align-items:flex-start}' +
'.rpv-tog{display:inline-flex;align-items:stretch;height:30px;background:#fff;border:1px solid #E2E1DE;border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.12);overflow:hidden;opacity:.94;transition:box-shadow .15s,transform .15s,opacity .15s;user-select:none}' +
'.rpv-tog:hover{opacity:1;box-shadow:0 4px 14px rgba(0,0,0,.2);transform:translateY(-1px);border-color:#E30613}' +
'.rpv-arrastando .rpv-tog{transform:none;box-shadow:0 6px 18px rgba(0,0,0,.26);cursor:grabbing}' +
'.rpv-grip{display:inline-flex;align-items:center;padding:0 3px 0 9px;color:#8C8A88;cursor:grab;font-size:12px;letter-spacing:-3px}' +
'.rpv-tb{display:inline-flex;align-items:center;gap:5px;background:none;border:0;border-left:1px solid #EFEEEC;cursor:pointer;color:#1A1A1D;padding:0 10px;font-size:12px;font-weight:600;white-space:nowrap;font-family:inherit}' +
'.rpv-grip+.rpv-tb{border-left:0}.rpv-tb:hover{background:#F4F3F1}.rpv-tb[disabled]{cursor:default;color:#A5A3A0}.rpv-tb[disabled]:hover{background:none}' +
'.rpv-tb.on{background:#FDECEC;color:#B4232B}.rpv-tb .dot{width:7px;height:7px;border-radius:50%;background:#A5A3A0}' +
'.rpv-tb.st-ok .dot{background:#1E8E3E}.rpv-tb.st-erro .dot{background:#E30613}.rpv-tb.st-liga .dot{background:#E0A100}' +
'.rpv-tb.st-tocando .dot{background:#E30613;animation:rpvpulsa 1s infinite}.rpv-tb.st-chamada .dot{background:#1E8E3E;animation:rpvpulsa 1.6s infinite}' +
'@keyframes rpvpulsa{0%{box-shadow:0 0 0 0 rgba(227,6,19,.5)}70%{box-shadow:0 0 0 6px rgba(227,6,19,0)}100%{box-shadow:0 0 0 0 rgba(227,6,19,0)}}' +
'.rpv-tb .cnt{background:#EEEDEB;color:#3A3A3D;border-radius:999px;padding:1px 6px;font-size:10.5px;font-weight:700}.rpv-tb-ntf.late .cnt{background:#E30613;color:#fff}' +
'.rpv-tog.fut .rpv-tb-ntf .cnt{background:#5C6066;color:#fff}.rpv-q{width:28px;justify-content:center;padding:0;font-size:10px;color:#5C6066}' +
'.rpv-card{background:#fff;border:1px solid #E2E1DE;border-radius:12px;width:320px;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.16);overflow:hidden;font-size:12px;color:#1A1A1D}' +
'.rpv-h{display:flex;align-items:center;gap:6px;padding:9px 12px;border-bottom:1px solid #EFEEEC;font-weight:700}' +
'.rpv-h .tt{flex:1}.rpv-h button{background:none;border:0;color:#8C8A88;cursor:pointer;font-size:14px}' +
'.rpv-b{padding:9px 12px}.rpv-b .nm{font-weight:700;font-size:13px;margin-bottom:3px}.rpv-b .mt{color:#5C6066;display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
'.rpv-acts{display:flex;gap:6px;padding:0 12px 10px}.rpv-acts button{flex:1;border-radius:7px;border:1px solid #E2E1DE;background:#fff;padding:6px;cursor:pointer;font-weight:600;font-size:12px}' +
'.rpv-acts button[disabled]{opacity:.5;cursor:default}.rpv-acts .pri{background:#E30613;border-color:#E30613;color:#fff}' +
'.rpv-list{max-height:300px;overflow-y:auto}.rpv-it{display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid #F4F3F1;cursor:pointer}.rpv-it:hover{background:#FAFAF9}' +
'.rpv-it .pos{width:16px;color:#A5A3A0;text-align:right}.rpv-it .bd{flex:1;min-width:0}.rpv-it .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.rpv-tag{border-radius:4px;padding:1px 5px;font-size:9.5px;font-weight:700;background:#EEF3F8;color:#5C6E80}.rpv-tag.m1{background:#FFE9E9;color:#B4232B}.rpv-tag.m2,.rpv-tag.m3{background:#FFF1E0;color:#A35300}' +
'.rpv-late{color:#B4232B;font-weight:700}.rpv-f{padding:7px 12px;border-top:1px solid #EFEEEC;font-size:10px;color:#8C8A88;display:flex;justify-content:space-between;gap:8px}' +
'.rpv-warn{background:#FFF8E6;color:#8A5A00;padding:6px 12px;font-size:11px}.rpv-nota{color:#8A8885;padding:4px 12px;font-size:10.5px}' +
'.rpv-ntf{display:flex;align-items:center;gap:7px;width:300px;max-width:calc(100vw - 32px);box-sizing:border-box;height:30px;padding:0 4px 0 10px;background:#fff;border:1px solid #E2E1DE;border-left:3px solid #E30613;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);font-size:11.5px;color:#1A1A1D;cursor:pointer}' +
'.rpv-ntf:hover{background:#FAFAF9}.rpv-ntf .ic{font-size:11px}.rpv-ntf .bd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rpv-ntf .qd{font-size:10.5px;color:#5C6066;white-space:nowrap}' +
'.rpv-ntf button{background:none;border:0;color:#8C8A88;cursor:pointer;font-size:14px;padding:0 6px}' +
'.rpv-root{gap:6px}' +
'.rpv-num{width:100%;box-sizing:border-box;border:1px solid #E2E1DE;border-radius:7px;padding:5px 8px;font-size:12.5px}' +
'.rpv-tag.m0{background:#E30613;color:#fff}.rpv-ligar{border-radius:7px;border:1px solid #1E8E3E;background:#1E8E3E;color:#fff;padding:4px 10px;cursor:pointer;font-weight:700;font-size:11.5px;align-self:center}.rpv-ligar[disabled]{opacity:.5;cursor:default}';

      function css() { if (document.getElementById(NS + '-css')) return; var st = document.createElement('style'); st.id = NS + '-css'; st.textContent = CSS; document.head.appendChild(st); }
      function raiz() {
        var c = document.getElementById(NS + '-root'), conf = cfg();
        if (!c) { c = document.createElement('div'); c.id = NS + '-root'; document.body.appendChild(c); }
        c.className = NS + '-root ' + NS + '-' + conf.position + (state.arrasto && state.arrasto.movendo ? ' ' + NS + '-arrastando' : '');
        var dir = conf.position.indexOf('right') > 0, p = state.pos;
        if (p && typeof p.top === 'number' && typeof p.lado === 'number') {             // posição arrastada pelo usuário (localStorage)
          p = clampPos(p);                                                               // outra tela/janela menor: nunca some da tela
          c.style.top = p.top + 'px'; c.style.bottom = '';
          if (dir) { c.style.right = p.lado + 'px'; c.style.left = ''; } else { c.style.left = p.lado + 'px'; c.style.right = ''; }
        } else {
          if (conf.position.indexOf('bottom') === 0) { c.style.bottom = conf.offset + 'px'; c.style.top = ''; } else { c.style.top = conf.offset + 'px'; c.style.bottom = ''; }
          if (dir) { c.style.right = MARGEM_DIREITA + 'px'; c.style.left = ''; } else { c.style.left = MARGEM_ESQUERDA + 'px'; c.style.right = ''; }
        }
        return c;
      }
      function tagCloser(q) {
        var n = q.nivelCloser, rot, cls = 'm1';
        if (n === 0) { rot = 'Chat sem resposta'; cls = 'm0'; }
        else if (n === 0.5) { rot = 'Reunião ' + hora(q.reuniao_em); cls = 'm0'; }
        else if (q.etapa_pendente) { rot = 'etapa a confirmar'; cls = ''; }
        else { rot = q.etapa || (n === 8 ? 'Outros funis' : 'Etapa'); cls = n <= 2 ? 'm1' : (n <= 5 ? 'm2' : ''); }
        return '<span class="rpv-tag ' + cls + '">' + esc(rot) + '</span>' + (q.pendentes ? '<span class="rpv-tag" title="outras tarefas pendentes deste lead">+' + q.pendentes + '</span>' : '');
      }
      function tag(q) {
        if (state.modoFila === 'closer' && q.nivelCloser != null) return tagCloser(q);
        return '<span class="rpv-tag m' + Math.floor(Fila.nivel(q)) + '">' + esc(Fila.ROTULO[q.momento] || 'Outras') + '</span>' +
               (q.origemPendente ? '<span class="rpv-tag" title="origem ainda não consultada: prioridade provisória">origem pendente</span>'
                : (q.grupo && q.grupo !== 'G9' ? '<span class="rpv-tag">' + esc(Fila.ROTULO_GRUPO[q.grupo]) + '</span>' : (q.momento === 'prospeccao' ? '<span class="rpv-tag">origem não informada</span>' : '')));
      }
      function nomeDe(q) { return q.nome || ('#' + q.eid); }

      function render() {
        if (state.destruido || !ativoParaEsteUsuario()) return;
        podarChats();
        var c = raiz(), now = agoraS(), conf = cfg(), html = '', agir = podeAgir();

        Fila.agruparNotif(state.notif).slice(0, 3).forEach(function (n) {
          // 0.5.3: aviso compacto (uma linha), para não cobrir o Kommo; som e notificação do navegador iguais
          html += '<div class="rpv-ntf" data-act="abrir" data-et="' + esc(n.etype) + '" data-eid="' + esc(n.eid) + '" title="' + esc(n.titulo) + '">' +
                  '<span class="ic">🔔</span><span class="bd"><b>' + esc(Fila.ROTULO[n.momento] || 'Tarefa') + (n.qtd > 1 ? ' · ' + n.qtd + ' iguais' : '') + '</b> · ' + esc(n.titulo) + '</span>' +
                  '<span class="qd' + (n.due < now ? ' rpv-late' : '') + '">' + esc(fmtQuando(n.due, now)) + '</span>' +
                  '<button data-act="fechar-ntf" data-tid="' + esc(n.ids.join(',')) + '" title="Fechar">×</button></div>';
        });
        if (state.resumoNotif) html += '<div class="rpv-card"><div class="rpv-b">+' + state.resumoNotif + ' tarefas vencendo agora — veja a fila.</div></div>';

        var at = state.atual, aqui = entidadeAtual();
        if (at && aqui && at.etype === aqui.etype && at.eid === aqui.eid) {
          html += '<div class="rpv-card"><div class="rpv-b"><div class="nm">' + esc(nomeDe(at)) + '</div><div class="mt">' + tag(at) +
                  '<span' + (at.due && at.due < now ? ' class="rpv-late"' : '') + '>' + esc(fmtQuando(at.due, now)) + '</span>' + (at.etapa ? '<span>' + esc(at.etapa) + '</span>' : '') + '</div>' +
                  '<div class="mt" style="margin-top:4px">' + esc(String(at.texto).slice(0, 160)) + '</div></div>' +
                  (at.id < 0 ? '<div class="rpv-warn">Responda o cliente no chat deste lead; o item sai da fila quando houver resposta.</div><div class="rpv-acts"><button data-act="pular">Pular 15 min</button></div></div>'
                   : '<div class="rpv-acts"><button class="pri" data-act="concluir"' + (agir ? '' : ' disabled') + '>Concluir e próximo</button><button data-act="pular">Pular 15 min</button></div></div>');
        }

        html += htmlVoz();

        if (state.open) {
          html += '<div class="rpv-card"><div class="rpv-h"><span class="tt">Sua fila · ' + state.fila.length + '</span>' +
                  '<button data-act="atualizar" title="Atualizar">↻</button><button data-act="painel" title="Fechar">×</button></div>';
          if (state.falha) html += '<div class="rpv-nota">' + esc(state.falha.msg) + ' Lista das ' + (state.dadosEm ? hora(state.dadosEm) : '—') + '; ao concluir, confiro a tarefa no Kommo.</div>';
          else if (state.dadosEm && !dadosRecentes()) html += '<div class="rpv-nota">Lista das ' + hora(state.dadosEm) + ' (há ' + Math.max(0, agoraS() - state.dadosEm) + ' s), atualizando; ao concluir, confiro a tarefa no Kommo.</div>';
          if (state.aviso) html += '<div class="rpv-warn">' + esc(state.aviso) + '</div>';
          if (state.chatsVencidos) html += '<div class="rpv-warn">Chats sem resposta desatualizados: escondidos até a próxima leitura.</div>';
          var mot = state.motivos || [], motChat = mot.filter(function (m) { return /^chats_/.test(m); }), motTar = mot.filter(function (m) { return !/^chats_/.test(m); });
          if (state.parcial && !mot.length) html += '<div class="rpv-warn">Fila parcial: algumas tarefas podem faltar.</div>';
          if (state.parcial && motTar.length) html += '<div class="rpv-warn">Fila parcial (' + esc(motTar.join(', ')) + '): algumas tarefas podem faltar.</div>';
          if (motChat.length) html += '<div class="rpv-warn">Chats: ' + esc(motChat.map(function (m) { return { chats_parcial: 'leitura parcial (pode faltar algum chat)', chats_limite: 'o Kommo pediu pausa', chats_atrasados: 'desatualizados', chats_indisponiveis: 'indisponíveis agora' }[m] || m; }).join('; ')) + '.</div>';
          if (!state.fila.length) {
            html += '<div class="rpv-b">' + (state.futura ? 'Nada vencido agora. Próxima às <b>' + esc(fmtQuando(state.futura.due, now)) + '</b> — o botão abre ela.' : 'Nenhuma tarefa pendente.') + '</div>';
          } else {
            html += '<div class="rpv-list">';
            state.fila.slice(0, 15).forEach(function (q, i) {
              html += '<div class="rpv-it" data-act="ir" data-i="' + i + '"><span class="pos">' + (i + 1) + '</span><span class="bd"><div class="nm">' + esc(nomeDe(q)) + '</div>' +
                      '<div class="mt">' + tag(q) + '<span' + (q.due && q.due < now ? ' class="rpv-late"' : '') + '>' + esc(fmtQuando(q.due, now)) + '</span></div></span></div>';
            });
            html += '</div>';
          }
          html += '<div class="rpv-f"><span>' + esc(state.modo) + (state.dadosEm ? ' · dados das ' + hora(state.dadosEm) : '') + '</span>' + (conf.atalho ? '<span>Alt+N</span>' : '') + '</div></div>';
        }

        // 0.5.3: pílula-toggle (Ligar · Notificações · fila). Os cards abrem embaixo dela (topo) ou em cima (base).
        var p = agir ? Fila.proximoDe(state.fila, state.futura, aqui) : null;
        var topo = conf.position.indexOf('top') === 0;
        var atrasado = state.fila.some(function (q) { return q.due && q.due < now; }) || state.notif.length > 0;
        var dica = p ? (p.futura ? 'Próxima às ' + hora(p.item.due) + ': ' : 'Próximo: ') + nomeDe(p.item) + ' · ' + (Fila.ROTULO[p.item.momento] || '') + (conf.atalho ? ' (Alt+N)' : '')
                     : (agir ? 'Sem tarefas' : 'Fila desatualizada');
        var pill = '<div class="rpv-tog' + (p ? (p.futura ? ' fut' : '') : ' off') + '">' +
                   '<span class="rpv-grip" data-drag="1" title="Arraste para mover · duplo clique volta ao lugar">⋮⋮</span>';
        if (conf.voz) {
          var vst = vozEmUso() ? (voz.emChamada ? 'chamada' : 'tocando') : ({ registrado: 'ok', erro: 'erro', carregando: 'liga', reconectando: 'liga', outra_aba: 'liga' }[voz.estado] || 'off');
          var vrot = { off: 'desligado', carregando: 'conectando…', registrado: 'pronto', reconectando: 'reconectando…', erro: 'com problema', outra_aba: 'ativo em outra aba' }[voz.estado] || voz.estado;
          var vdica = 'Ramal: ' + vrot + (voz.msg ? ' — ' + voz.msg : '') + ' · clique para ' + (state.vozAberta ? 'esconder' : 'abrir');
          pill += '<button class="rpv-tb rpv-tb-voz' + (state.vozAberta ? ' on' : '') + ' st-' + vst + '" data-act="voz" aria-pressed="' + (state.vozAberta ? 'true' : 'false') + '" title="' + esc(vdica) + '">' +
                  '<span class="dot"></span>📞 Ligar</button>';
        }
        pill += '<button class="rpv-tb rpv-tb-ntf' + (atrasado ? ' late' : '') + '" ' + (p ? 'data-act="avancar"' : 'disabled') + ' title="' + esc(dica) + '">🔔' +
                (state.fila.length ? '<span class="cnt">' + state.fila.length + '</span>' : '') + '</button>' +
                '<button class="rpv-tb rpv-q" data-act="painel" aria-pressed="' + (state.open ? 'true' : 'false') + '" title="' + (state.open ? 'Esconder a fila' : 'Ver a fila') + '">' + (state.open === topo ? '▴' : '▾') + '</button></div>';
        html = topo ? pill + html : html + pill;
        var foco = document.activeElement && document.activeElement.id === NS + '-manual', pos = foco ? document.activeElement.selectionStart : 0;
        c.innerHTML = html;
        if (foco) { var inp = document.getElementById(NS + '-manual'); if (inp && inp.focus) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (e) {} } }
      }

      function aoClicar(ev) {
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        var root = document.getElementById(NS + '-root');
        if (!el || !root || !root.contains(el)) return;
        var act = el.getAttribute('data-act');
        if (act === 'avancar') avancar();
        else if (act === 'painel') { state.open = !state.open; salvarUi(); render(); }
        else if (act === 'voz') { state.vozAberta = !state.vozAberta; salvarUi(); render(); }
        else if (act === 'atualizar') ciclo(state.geracao, true);
        else if (act === 'concluir') concluirEProximo(state.atual);
        else if (act === 'pular') pular(state.atual);
        else if (act === 'ir') { if (!podeAgir() || podarChats()) { render(); return; } var q = state.fila[parseInt(el.getAttribute('data-i'), 10)]; if (q) { state.atual = q; abrir(q.etype, q.eid); render(); } }
        else if (act === 'abrir') abrir(el.getAttribute('data-et'), el.getAttribute('data-eid'));
        else if (act === 'voz-ligar') discarVoz(el.getAttribute('data-tel'));
        else if (act === 'voz-manual') discarVoz(String(voz.manual || '').trim(), true);
        else if (act === 'voz-atender') atenderVoz();
        else if (act === 'voz-desligar') desligarVoz();
        else if (act === 'voz-mudo') mudoVoz();
        else if (act === 'voz-aqui') usarAqui(state.geracao);
        else if (act === 'voz-reconectar') { pararVoz(); voz.estado = 'off'; voz.msg = ''; iniciarVoz(state.geracao, false); }
        else if (act === 'fechar-ntf') { var tids = String(el.getAttribute('data-tid') || '').split(',').map(Number); state.notif = state.notif.filter(function (n) { return tids.indexOf(n.id) === -1; }); lsSet('notif', state.notif); render(); }
      }
      // estado da pílula por usuário (padrão: tudo fechado). Nunca guarda credencial.
      function salvarUi() { lsSet('ui', { voz: !!state.vozAberta, fila: !!state.open }); }
      function carregarUi() {
        var u = lsGet('ui', null) || {};
        state.vozAberta = u.voz === true; state.open = u.fila === true;
        var p = lsGet('pos', null);
        state.pos = p && typeof p.top === 'number' && typeof p.lado === 'number' ? p : null;
      }
      // arrastar a pílula pela alça ⋮⋮ (mouse); duplo clique na alça volta à posição padrão
      function aoApertar(ev) {
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-drag]') : null;
        var root = document.getElementById(NS + '-root');
        if (!el || !root || !root.contains(el) || ev.button) return;
        var r = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
        if (!r) return;
        ev.preventDefault();
        state.arrasto = { x: ev.clientX, y: ev.clientY, top: r.top, lado: cfg().position.indexOf('right') > 0 ? (window.innerWidth - r.right) : r.left, movendo: false };
      }
      function clampPos(p) {
        var W = window.innerWidth || 1200, H = window.innerHeight || 800;
        return { top: Math.max(0, Math.min(H - 40, Math.round(p.top))), lado: Math.max(0, Math.min(W - 120, Math.round(p.lado))) };
      }
      function aoMover(ev) {
        var a = state.arrasto; if (!a) return;
        var dx = ev.clientX - a.x, dy = ev.clientY - a.y;
        if (!a.movendo && Math.abs(dx) + Math.abs(dy) < 4) return;
        a.movendo = true;
        var dir = cfg().position.indexOf('right') > 0, W = window.innerWidth || 1200, H = window.innerHeight || 800;
        state.pos = clampPos({ top: a.top + dy, lado: a.lado + (dir ? -dx : dx) });
        raiz();
      }
      function aoSoltar() {
        var a = state.arrasto; if (!a) return;
        state.arrasto = null;
        if (a.movendo) lsSet('pos', state.pos);
        raiz();
      }
      function aoDuploClique(ev) {
        var el = ev.target && ev.target.closest ? ev.target.closest('[data-drag]') : null;
        var root = document.getElementById(NS + '-root');
        if (!el || !root || !root.contains(el)) return;
        state.pos = null; lsSet('pos', null); raiz();
      }
      function aoDigitar(ev) {                                              // guarda o que foi digitado (o render recria o campo)
        if (ev.target && ev.target.id === NS + '-manual') voz.manual = String(ev.target.value || '').slice(0, 30);
      }
      function aoTeclar(ev) {
        if (ev.target && ev.target.id === NS + '-manual' && ev.key === 'Enter') { ev.preventDefault(); discarVoz(String(voz.manual || '').trim(), true); return; }
        if (!cfg().atalho || !ev.altKey || ev.ctrlKey || ev.metaKey || String(ev.key).toLowerCase() !== 'n') return;
        var t = ev.target && ev.target.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA' || (ev.target && ev.target.isContentEditable)) return;
        ev.preventDefault(); avancar();
      }
      function aoArmazenar(ev) { if (ev.key === key(kSnap())) carregarSnapshot(); }

      function boot() {
        if (state.booted && !state.destruido) { raiz(); render(); return; }
        var sys = {};
        try { sys = self.system() || {}; } catch (e) { sys = {}; }
        state.uid = sys.user_id || (window.AMOCRM && AMOCRM.constant && AMOCRM.constant('user') && AMOCRM.constant('user').id) || null;
        state.sub = sys.subdomain || location.hostname.split('.')[0] || 'acc';
        if (!state.uid || !ativoParaEsteUsuario()) return;   // fora da lista de teste: widget inerte
        state.booted = true; state.destruido = false; state.geracao++; state.carregando = false; state.reTentar = 0; state.rev = ''; state.perfil = perfil();
        var g = state.geracao, p = self.params || {};
        state.base = String(p.cdn_path || p.path || '').replace(/\/+$/, '');
        try { state.atual = JSON.parse(sessionStorage.getItem(key('atual')) || 'null'); } catch (e) { state.atual = null; }
        state.notif = lsGet('notif', []);
        carregarUi();
        css(); raiz(); initAudio();
        ouvir(document, 'click', aoClicar, false);
        ouvir(document, 'keydown', aoTeclar, false);
        ouvir(document, 'input', aoDigitar, false);
        ouvir(document, 'mousedown', aoApertar, false);
        ouvir(document, 'mousemove', aoMover, false);
        ouvir(document, 'mouseup', aoSoltar, false);
        ouvir(document, 'dblclick', aoDuploClique, false);
        ouvir(document, 'mouseleave', aoSoltar, false);
        ouvir(window, 'blur', aoSoltar, false);
        ouvir(window, 'resize', function () { if (state.pos) raiz(); }, false);
        ouvir(window, 'storage', aoArmazenar, false);
        var prime = function () {
          try { if (state.audio) { state.audio.muted = true; state.audio.play().then(function () { state.audio.pause(); state.audio.currentTime = 0; state.audio.muted = false; }).catch(function () { state.audio.muted = false; }); } } catch (e) {}
          try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
          document.removeEventListener('click', prime, true);
        };
        ouvir(document, 'click', prime, true);

        carregarSnapshot(); render();
        atraso(function () { ciclo(g, false); }, Math.floor(Math.random() * 3000));          // jitter inicial
        intervalo(function () { ciclo(g, false); }, cfg().poll * 1000 + Math.floor(Math.random() * 5000));
        var ultima = location.pathname;
        intervalo(function () {
          if (location.pathname !== ultima) { ultima = location.pathname; if (cfg().voz && voz.estado === 'registrado') telefonesAqui(g); render(); }
          else if (trocarPerfil()) ciclo(g, true);     // override do modo mudou sem onSave
          else if (podarChats()) render();          // chat venceu pelo relógio (sem leitura nova, pausa ou aba seguidora)
          else if (state.vozAte && Date.now() >= state.vozAte && !vozEmUso()) { state.vozAte = 0; render(); }   // fim da janela pós-ligação
        }, 700);
        intervalo(function () { cicloVoz(g); }, 1000);                     // liga/desliga o telefone conforme o setting voz
        if (cfg().voz) iniciarVoz(g, false);
      }

      function destruir() {
        state.destruido = true; state.geracao++; state.carregando = false; state.reTentar = 0;
        pararVoz(); voz.estado = 'off'; voz.msg = ''; voz.aviso = ''; voz.tel = { chave: '', contatos: null, erro: '', carregando: false };
        state.timers.forEach(function (x) { if (x.t === 'i') clearInterval(x.h); else clearTimeout(x.h); });
        state.timers = [];
        state.ouvintes.forEach(function (o) { try { o[0].removeEventListener(o[1], o[2], o[3]); } catch (e) {} });
        state.ouvintes = [];
        var lock = lsGet(kLider(), null);
        if (lock && lock.aba === ABA) lsSet(kLider(), null);
        var c = document.getElementById(NS + '-root'); if (c && c.parentNode) c.parentNode.removeChild(c);
        var au = document.getElementById(NS + '-audio'); if (au && au.parentNode) { try { au.srcObject = null; } catch (e) {} au.parentNode.removeChild(au); }
        state.booted = false;
      }

      this.callbacks = {
        render: function () { return true; },
        init: function () { try { boot(); } catch (e) { if (window.console) console.error('[ruston-prevendas] init', e); } return true; },
        bind_actions: function () { return true; },
        settings: function () { return true; },
        onSave: function () { try { if (trocarPerfil()) ciclo(state.geracao, true); cicloVoz(state.geracao); } catch (e) {} return true; },
        destroy: function () { try { destruir(); } catch (e) {} }
      };
      return this;
    };
    return CustomWidget;
  });
})();
