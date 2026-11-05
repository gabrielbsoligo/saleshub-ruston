// node --test kommo-widget/ruston-prevendas/tests/widget.test.cjs
// Roda o widget inteiro numa VM com DOM/jQuery/$authorizedAjax falsos: ciclo completo, remoção de tarefa
// que saiu da fila do usuário, falha de leitura, modo degradado e init → destroy → init (sem vazamento).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8')

function ambiente() {
  const elems = {}
  const ouvintes = []
  const timers = new Map(); let seq = 0
  const mk = (tag) => ({ tag, id: '', className: '', style: {}, innerHTML: '', textContent: '', parentNode: null,
    contains: () => true, removeChild(c) { delete elems[c.id] }, appendChild(c) { c.parentNode = this; if (c.id) elems[c.id] = c } })
  const body = mk('body'), head = mk('head')
  const document = {
    body, head,
    getElementById: (id) => elems[id] || null,
    createElement: (t) => { const e = mk(t); return new Proxy(e, { set(o, k, v) { o[k] = v; if (k === 'id') elems[v] = o; return true } }) },
    addEventListener: (ev, fn, opt) => ouvintes.push([ev, fn, opt]),
    removeEventListener: (ev, fn, opt) => { const i = ouvintes.findIndex((o) => o[0] === ev && o[1] === fn); if (i >= 0) ouvintes.splice(i, 1) },
  }
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m } }
  const window = { addEventListener: (ev, fn) => ouvintes.push(['w:' + ev, fn]), removeEventListener: (ev, fn) => { const i = ouvintes.findIndex((o) => o[0] === 'w:' + ev && o[1] === fn); if (i >= 0) ouvintes.splice(i, 1) } }
  const ctx = {
    document, window, location: { pathname: '/leads/pipeline', hostname: 'financeirorustonengenhariacombr.kommo.com', origin: 'https://x' },
    localStorage: store(), sessionStorage: store(), console, Math, Date, JSON, String, Number, Object, Array, parseInt, isNaN, encodeURIComponent,
    alert: () => {}, Audio: function () { return { play: () => Promise.resolve(), pause() {} } },
    setInterval: (fn, ms) => { const h = ++seq; timers.set(h, { fn, ms, i: true }); return h },
    clearInterval: (h) => timers.delete(h),
    setTimeout: (fn, ms) => { const h = ++seq; timers.set(h, { fn, ms, i: false }); return h },
    clearTimeout: (h) => timers.delete(h),
  }
  ctx.window.Notification = undefined
  // roteador do Kommo falso: navegar = mudar o caminho
  ctx.AMOCRM = ctx.window.AMOCRM = { Router: { navigate: (p) => { ctx.location.pathname = p } } }
  let Widget
  ctx.define = (deps, f) => { Widget = f(ctx.$) }
  // jQuery falso: só $.ajax para a API do Kommo (modo degradado / PATCH)
  ctx.$ = { ajax: (o) => ctx.__kommo(o) }
  ctx.__kommo = () => ({ done() { return this }, fail(fn) { fn({ status: 0, getResponseHeader: () => null }); return this } })
  vm.runInNewContext(SRC, ctx)
  // tipo: 't' = só timeouts (ex.: jitter inicial), 'i' = só intervalos (um tique), omitido = todos
  const rodarTimers = (tipo) => { for (const [h, t] of [...timers]) { if (tipo === 't' && t.i) continue; if (tipo === 'i' && !t.i) continue; if (!t.i) timers.delete(h); t.fn() } }
  return { ctx, elems, ouvintes, timers, rodarTimers, Widget: () => Widget }
}

function instanciar(env, respostas, settings = {}) {
  const W = env.Widget()
  const w = new W()
  w.system = () => ({ user_id: 11420911, subdomain: 'financeirorustonengenhariacombr' })
  w.get_settings = () => ({ endpoint: 'https://srv/fila', usuarios: '11420911', ...settings })
  w.params = { cdn_path: '/w' }
  let n = 0
  w.$authorizedAjax = () => {
    const idx = Math.min(n++, respostas.length - 1)
    // como o servidor real: toda leitura ok traz gerado_em; nos testes, carimbo crescente se o caso não definir
    const r = respostas[idx] && respostas[idx].ok && respostas[idx].gerado_em == null ? { ...respostas[idx], gerado_em: AGORA + n } : respostas[idx]
    return { then: (ok, err) => (r.erro ? err({ status: r.status || 401, responseJSON: { erro: r.erro } }) : ok(r)) }
  }
  return w
}

const AGORA = Math.floor(Date.now() / 1000)
const UI_KEY = 'rpv_ui_financeirorustonengenhariacombr_11420911'
const tarefa = (id, extra = {}) => ({ id, entity_type: 'leads', entity_id: id * 10, due: AGORA - 60, momento: 'follow_up', grupo: 'G1', urgente: false, texto: 't' + id, lead_nome: 'Lead ' + id, ...extra })

test('ciclo completo: fila vem do servidor; tarefa que sai (reatribuída/concluída) some da fila', () => {
  const env = ambiente()
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1), tarefa(2, { momento: 'anti_noshow', grupo: 'G9' })], frescor: { atraso_s: 30, status: 'done' } },
    { ok: true, itens: [tarefa(1)], frescor: { atraso_s: 30, status: 'done' } },
  ])
  w.callbacks.init()
  env.rodarTimers('t')                                // jitter inicial → 1º ciclo
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Próximo/); assert.match(html, /<span class="cnt">2<\/span>/)
  env.rodarTimers('i')                                // 2º ciclo: tarefa 2 saiu
  html = env.elems['rpv-root'].innerHTML
  assert.match(html, /<span class="cnt">1<\/span>/)
  const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'))
  assert.deepEqual(snap.itens.map((t) => t.id), [1])
})

test('servidor e Kommo falham: mantém a lista anterior com aviso de desatualizada (não finge "ok")', () => {
  const env = ambiente()
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1)], frescor: { atraso_s: 30, status: 'done' } },
    { erro: 'falha_banco', status: 503 },
  ])
  w.callbacks.init()
  env.rodarTimers('t')                                // 1º ciclo: ok (1 tarefa)
  env.rodarTimers('i')                                // 2º ciclo: servidor 503 e Kommo falha
  // o aviso aparece no painel; abre o painel e confere
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'painel' }) } })
  const html = env.elems["rpv-root"].innerHTML
  assert.match(html, /Não consegui atualizar a fila/)
  assert.match(html, /<span class="cnt">1<\/span>/)   // lista anterior mantida, com aviso
})

test('modo degradado: servidor 401 → lê do Kommo pela sessão e avisa', () => {
  const env = ambiente()
  env.ctx.__kommo = () => ({
    done(fn) { fn({ _embedded: { tasks: [{ id: 7, entity_type: 'leads', entity_id: 70, complete_till: AGORA - 10, text: 'CADENCIA: lead respondeu com interesse' }] } }, 'ok', { status: 200 }); return this },
    fail() { return this },
  })
  const w = instanciar(env, [{ erro: 'jwt_conta', status: 401 }])
  w.callbacks.init(); env.rodarTimers()
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'painel' }) } })
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Classificação indisponível \(jwt_conta\)/)
  assert.match(html, /Conexão/)                       // o "Ligar AGORA" é reconhecido localmente
})

test('usuário fora da lista de teste: widget inerte (não consulta nada)', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)] }], { usuarios: '999' })
  let chamou = false; w.$authorizedAjax = () => { chamou = true; return { then() {} } }
  w.callbacks.init(); env.rodarTimers()
  assert.equal(chamou, false); assert.equal(env.elems['rpv-root'], undefined); assert.equal(env.timers.size, 0)
})

test('init → destroy → init: sem timers, ouvintes ou raiz órfãos; lock liberado', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)], frescor: { atraso_s: 1, status: 'done' } }])
  w.callbacks.init(); env.rodarTimers()
  assert.ok(env.timers.size > 0); assert.ok(env.ouvintes.length >= 3)
  w.callbacks.destroy()
  assert.equal(env.timers.size, 0); assert.equal(env.ouvintes.length, 0); assert.equal(env.elems['rpv-root'], undefined)
  assert.equal(env.ctx.localStorage.getItem('rpv_lider.auto.v2_financeirorustonengenhariacombr_11420911'), 'null')
  w.callbacks.init(); env.rodarTimers()
  assert.ok(env.elems['rpv-root']); assert.equal(env.ouvintes.filter((o) => o[0] === 'keydown').length, 1)
})

test('segunda aba não consulta enquanto a líder estiver ativa (usa o snapshot)', () => {
  const env = ambiente()
  const a = instanciar(env, [{ ok: true, itens: [tarefa(1)], frescor: { atraso_s: 1, status: 'done' } }])
  a.callbacks.init(); env.rodarTimers()
  // simula outra aba: lock de outra aba ainda válido
  env.ctx.localStorage.setItem('rpv_lider.auto.v2_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 60000 }))
  let chamadas = 0
  a.$authorizedAjax = () => { chamadas++; return { then() {} } }
  env.rodarTimers()
  assert.equal(chamadas, 0)
})

// ---- roteador do jQuery falso (API do Kommo pela sessão) ----
function kommo(env, handler) {
  env.ctx.__kommo = (o) => {
    const r = handler(o) || { status: 0 }
    const ok = r.status >= 200 && r.status < 300
    return {
      done(fn) { if (ok) fn(r.body, 'ok', { status: r.status }); return this },
      fail(fn) { if (!ok) fn({ status: r.status, getResponseHeader: (h) => (r.headers || {})[h] ?? null }); return this },
    }
  }
}
const SNAP = 'rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'
const viva = (id) => ({ id, is_completed: false, responsible_user_id: 11420911, entity_type: 'leads', entity_id: id * 10, complete_till: AGORA - 60, text: 't' + id })

test('concluir: a réplica atrasada (ainda com a tarefa aberta) não a ressuscita no ciclo seguinte', () => {
  const env = ambiente()
  kommo(env, (o) => {
    if (o.method === 'GET' && /\/api\/v4\/tasks\/\d+$/.test(o.url)) return { status: 200, body: viva(Number(o.url.split('/').pop())) }
    if (o.method === 'PATCH') return { status: 200, body: {} }
    return { status: 0 }
  })
  const resp = { ok: true, itens: [tarefa(1), tarefa(2)], frescor: { atraso_s: 30, status: 'done' } }
  const w = instanciar(env, [resp, resp])
  w.callbacks.init(); env.rodarTimers('t')
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  // abre o 1º (avancar) e conclui
  clique({ target: { closest: () => ({ getAttribute: () => 'avancar' }) } })
  assert.equal(env.ctx.location.pathname, '/leads/detail/10')
  clique({ target: { closest: () => ({ getAttribute: () => 'concluir' }) } })
  // o concluir pede nova leva já; o servidor (cache) ainda devolve [1,2]: a marca local esconde a 1
  assert.ok(env.elems['rpv-root'].innerHTML.includes('<span class="cnt">1</span>'))
  env.rodarTimers('i')                                  // ciclo seguinte, ainda com [1,2]
  assert.ok(env.elems['rpv-root'].innerHTML.includes('<span class="cnt">1</span>'))
  assert.equal(env.ctx.location.pathname, '/leads/detail/20')   // avançou para a 2
})

test('outra aba recebe a mutação (revisão nova) e o estado de falha, preservando a idade dos dados', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), tarefa(2)], frescor: { atraso_s: 1, status: 'done' } }])
  w.callbacks.init(); env.rodarTimers('t')
  const storage = env.ouvintes.find((o) => o[0] === 'w:storage')[1]
  // outra aba concluiu a tarefa 2 no mesmo segundo: mesma idade, revisão nova
  const s = JSON.parse(env.ctx.localStorage.getItem(SNAP))
  const dadosEm = s.dadosEm
  s.itens = s.itens.filter((t) => t.id !== 2); s.rev = 'outra-rev'
  env.ctx.localStorage.setItem(SNAP, JSON.stringify(s))
  storage({ key: SNAP })
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
  // a líder (outra aba) registrou falha: esta aba mostra o aviso com a hora real dos dados
  s.rev = 'falha-rev'; s.falha = { em: AGORA, msg: 'Não consegui atualizar a fila (503 / 0).' }
  env.ctx.localStorage.setItem(SNAP, JSON.stringify(s))
  storage({ key: SNAP })
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'painel' }) } })
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Não consegui atualizar a fila/)
  assert.equal(JSON.parse(env.ctx.localStorage.getItem(SNAP)).dadosEm, dadosEm)
})

test('destroy com requisição pendente não trava o próximo init', () => {
  const env = ambiente()
  const w = instanciar(env, [])
  let chamadas = 0; const pendentes = []
  w.$authorizedAjax = () => { chamadas++; return { then: (ok) => { pendentes.push(ok) } } }
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(chamadas, 1)
  w.callbacks.destroy()
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(chamadas, 2)                              // novo ciclo saiu
  pendentes[0]({ ok: true, itens: [tarefa(9)] })     // resposta ANTIGA (antes do destroy) chega depois: ignorada
  assert.equal(env.ctx.localStorage.getItem(SNAP), null)
})

test('429 com Retry-After numa página posterior pausa todas as abas (inclusive o Atualizar)', () => {
  const env = ambiente()
  const pagina1 = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, entity_type: 'leads', entity_id: i + 1, complete_till: AGORA - 60 }))
  let gets = 0
  kommo(env, (o) => {
    if (!o.url.includes('responsible_user_id')) return { status: 0 }
    gets++
    return o.url.includes('page=1') ? { status: 200, body: { _embedded: { tasks: pagina1 } } } : { status: 429, headers: { 'Retry-After': '120' } }
  })
  const w = instanciar(env, [{ erro: 'falha_banco', status: 503 }])
  w.callbacks.init(); env.rodarTimers('t'); env.rodarTimers('t')                 // página 1, depois página 2 (429)
  const pausa = JSON.parse(env.ctx.localStorage.getItem('rpv_pausa_financeirorustonengenhariacombr_11420911'))
  assert.ok(pausa > Date.now() + 100 * 1000)
  assert.equal(JSON.parse(env.ctx.localStorage.getItem(SNAP)).itens.length, 250)   // parcial publicado, com aviso
  const antes = gets
  env.rodarTimers('i')
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'atualizar' }) } })
  assert.equal(gets, antes)                              // nem o ciclo nem o Atualizar furam a pausa
})

test('servidor 503 kommo_429: pausa todas as abas e NÃO cai no modo degradado (que também bateria no Kommo)', () => {
  const env = ambiente()
  let gets = 0
  kommo(env, () => { gets++; return { status: 200, body: { _embedded: { tasks: [] } } } })
  const w = instanciar(env, [{ erro: 'kommo_429', status: 503 }])
  w.$authorizedAjax = () => ({ then: (ok, err) => err({ status: 503, responseJSON: { erro: 'kommo_429', retry_after: 90 } }) })
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(gets, 0)
  const pausa = JSON.parse(env.ctx.localStorage.getItem('rpv_pausa_financeirorustonengenhariacombr_11420911'))
  assert.ok(pausa > Date.now() + 80 * 1000)
})

test('com falha registrada, ações CONTINUAM (decisão do Gabriel): Próximo ativo, aviso discreto, Concluir confere ao vivo e conclui', () => {
  const env = ambiente()
  let patches = 0, conferiu = 0
  kommo(env, (o) => {
    if (o.method === 'PATCH') { patches++; return { status: 200, body: {} } }
    if (o.method === 'GET' && /\/api\/v4\/tasks\/1$/.test(o.url)) { conferiu++; return { status: 200, body: viva(1) } }
    return { status: 0 }
  })
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1)], frescor: { atraso_s: 1, status: 'done' } },
    { erro: 'falha_banco', status: 503 },
  ])
  w.callbacks.init(); env.rodarTimers('t'); env.rodarTimers('i')       // 2º ciclo falha (servidor + Kommo)
  assert.ok(JSON.parse(env.ctx.localStorage.getItem(SNAP)).falha)
  assert.match(env.elems['rpv-root'].innerHTML, /data-act="avancar"/)
  clicar(env, 'painel'); assert.match(env.elems['rpv-root'].innerHTML, /rpv-nota[^>]*>Não consegui atualizar a fila[^<]*confiro a tarefa no Kommo/)
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /data-act="concluir" disabled/)
  clicar(env, 'concluir')
  assert.equal(conferiu, 1); assert.equal(patches, 1)
})

test('lista completa do servidor: o widget ordena; parcial e origem pendente aparecem com motivo', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), tarefa(2, { momento: 'anti_noshow', grupo: 'G9' })], parcial: true, motivos_parcial: ['vazao_leads'], origem_pendente: 3 }])
  w.callbacks.init(); env.rodarTimers('t')
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'painel' }) } })
  const html = env.elems['rpv-root'].innerHTML
  assert.ok(html.includes('Fila parcial (vazao_leads)'))
  assert.ok(html.includes('3 tarefa(s) com origem ainda não consultada'))
  assert.ok(html.indexOf('Lead 2') < html.indexOf('Lead 1'))      // anti no-show antes do follow-up
})

test('servidor ocupado/em andamento: pausa curta e NÃO cai no modo degradado', () => {
  const env = ambiente()
  let gets = 0
  kommo(env, () => { gets++; return { status: 200, body: { _embedded: { tasks: [] } } } })
  const w = instanciar(env, [])
  w.$authorizedAjax = () => ({ then: (ok, err) => err({ status: 503, responseJSON: { erro: 'ocupado', retry_after: 3 } }) })
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(gets, 0)
  assert.ok(JSON.parse(env.ctx.localStorage.getItem('rpv_pausa_financeirorustonengenhariacombr_11420911')) > Date.now())
})

test('P1: resposta com dados de 24h (cache em andamento) não rejuvenesce: idade real, sem notificação; ações com aviso', () => {
  const env = ambiente()
  const velho = AGORA - 86400
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)], em_andamento: true, gerado_em: velho }])
  w.callbacks.init(); env.rodarTimers('t')
  const snap = JSON.parse(env.ctx.localStorage.getItem(SNAP))
  assert.equal(snap.dadosEm, velho)                                   // idade real preservada
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /data-act="avancar"/)                           // ação liberada (Concluir confere ao vivo)
  assert.doesNotMatch(html, /rpv-ntf/)                                // sem notificação sobre dado vencido
  clicar(env, 'painel'); html = env.elems['rpv-root'].innerHTML
  assert.match(html, /rpv-nota[^>]*>Lista das [^<]*atualizando/)
})

test('P1: depois de uma falha, um cache velho não limpa a falha (idade real mantida)', () => {
  const env = ambiente()
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1)], gerado_em: AGORA },
    { erro: 'falha_banco', status: 503 },
    { ok: true, itens: [tarefa(1)], em_andamento: true, gerado_em: AGORA - 86400 },
  ])
  w.callbacks.init(); env.rodarTimers('t'); env.rodarTimers('i'); env.rodarTimers('i')
  assert.ok(JSON.parse(env.ctx.localStorage.getItem(SNAP)).falha)      // a falha continua (cache velho não comprova recuperação)
})

test('P4: origem pendente tem etiqueta própria (não "origem não informada")', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1, { momento: 'prospeccao', grupo: 'G9', origem_pendente: true }), tarefa(2, { momento: 'prospeccao', grupo: 'G9' })], gerado_em: AGORA }])
  w.callbacks.init(); env.rodarTimers('t')
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'painel' }) } })
  const html = env.elems['rpv-root'].innerHTML
  assert.equal((html.match(/>origem pendente</g) || []).length, 1)
  assert.equal((html.match(/>origem não informada</g) || []).length, 1)
})

// ---- frescor depois de falha: resposta igual/anterior não substitui nem limpa a falha ----
function cenarioFalha(terceira) {
  const env = ambiente()
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1), tarefa(2)], gerado_em: AGORA },       // leitura atual
    { erro: 'falha_banco', status: 503 },                                // refresh falha (servidor + Kommo)
    terceira,
  ])
  w.callbacks.init(); env.rodarTimers('t'); env.rodarTimers('i'); env.rodarTimers('i')
  return { env, snap: JSON.parse(env.ctx.localStorage.getItem(SNAP)) }
}
test('após falha: cache ANTERIOR (−30 s, ainda dentro de 3 ciclos) é ignorado — falha, dadosEm e ids preservados', () => {
  const { env, snap } = cenarioFalha({ ok: true, itens: [tarefa(9)], em_andamento: true, gerado_em: AGORA - 30 })
  assert.ok(snap.falha); assert.equal(snap.dadosEm, AGORA); assert.deepEqual(snap.itens.map((t) => t.id), [1, 2])
  clicar(env, 'painel'); assert.match(env.elems['rpv-root'].innerHTML, /Não consegui atualizar a fila/)
})
test('após falha: cache com o MESMO gerado_em também é ignorado', () => {
  const { env, snap } = cenarioFalha({ ok: true, itens: [tarefa(9)], em_andamento: true, gerado_em: AGORA })
  assert.ok(snap.falha); assert.equal(snap.dadosEm, AGORA); assert.deepEqual(snap.itens.map((t) => t.id), [1, 2])
  clicar(env, 'painel'); assert.match(env.elems['rpv-root'].innerHTML, /Não consegui atualizar a fila/)
})
test('após falha: só uma leitura POSTERIOR à falha limpa a falha e reabilita as ações', () => {
  const { env, snap } = cenarioFalha({ ok: true, itens: [tarefa(3)], gerado_em: Math.floor(Date.now() / 1000) + 5 })
  assert.equal(snap.falha, null); assert.deepEqual(snap.itens.map((t) => t.id), [3])
  assert.match(env.elems['rpv-root'].innerHTML, /data-act="avancar"/)
})

// ---------------- telefone (webphone 4com) ----------------
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
// Web Locks falso, COMPARTILHADO entre "abas" (ambientes): exclusivo, ifAvailable e steal (rejeita o dono anterior)
function travasFalsas() {
  let dono = null
  return {
    request(name, opts, cb) {
      return new Promise((res, rej) => {
        if (dono && !opts.steal) { Promise.resolve(cb(null)).then(res, rej); return }
        if (dono && opts.steal) { const d = dono; dono = null; d.rej(Object.assign(new Error('stolen'), { name: 'AbortError' })) }
        const eu = { rej }; dono = eu
        Promise.resolve(cb({ name })).then((v) => { if (dono === eu) dono = null; res(v) }, (e) => { if (dono === eu) dono = null; rej(e) })
      })
    },
    temDono: () => !!dono,
  }
}
function fakeJsSIP(reg) {
  return {
    WebSocketInterface: function (url) { this.url = url },
    UA: function (cfg) {
      const h = {}; reg.cfg = cfg; reg.ua = this; reg.n = (reg.n || 0) + 1
      this.on = (e, f) => { h[e] = f }; this.start = () => { reg.started = (reg.started || 0) + 1 }; this.stop = () => { reg.stopped = (reg.stopped || 0) + 1 }
      reg.emit = (e, a) => h[e] && h[e](a)
    },
  }
}
function sessao(integrada) {
  const s = { h: {}, on(e, f) { this.h[e] = f }, answer() { this.atendida = true; this.h.accepted && this.h.accepted() }, terminate() { this.encerrada = true; this.h.ended && this.h.ended({ cause: 'Terminated' }) }, mute() {}, unmute() {} }
  return { originator: 'remote', session: s, request: { headers: integrada ? { 'X-Api4comintegratedcall': 1 } : {}, getHeader: (n) => (n === 'X-Api4comintegratedcall' && integrada ? 'true' : undefined) } }
}
const CRED = { ok: true, provedor: '4com', wss: 'wss://ruston.api4com.com:6443', dominio: 'ruston.api4com.com', ramal: '1006', realm: 'ruston.api4com.com', ha1: 'h'.repeat(32), uri: 'sip:1006@ruston.api4com.com', nome: 'Gabriel' }
// rotas: acao → resposta | função(corpo) → resposta | 'adiar' (devolve um controle para responder depois)
function comVoz(env, reg, rotas, settings = {}, travas = travasFalsas()) {
  env.ctx.window.JsSIP = fakeJsSIP(reg)
  env.ctx.navigator = { locks: travas }
  // 0.5.3: o telefone fica atrás do toggle "Ligar" (padrão fechado). Os testes de telefone partem do toggle ABERTO
  // (estado salvo por usuário); os testes do toggle em si estão em "pílula-toggle".
  if (!settings.__fechado) env.ctx.localStorage.setItem(UI_KEY, JSON.stringify({ voz: true, fila: false }))
  let conf = { endpoint: 'https://srv/fila', usuarios: '11420911', voz: 'Y', ...settings }
  const w = instanciar(env, [{ ok: true, itens: [] }])
  w.get_settings = () => conf
  const chamadas = [], adiadas = []
  w.$authorizedAjax = (o) => {
    const b = JSON.parse(o.data || '{}'); chamadas.push({ url: o.url, ...b })
    let r = b.acao ? rotas[b.acao] : { ok: true, itens: [], gerado_em: AGORA + chamadas.length }
    if (r === 'adiar') return { then: (ok, err) => adiadas.push({ ok, err }) }
    if (typeof r === 'function') r = r(b)
    r = r || { erro: 'x' }
    return { then: (ok, err) => (r.erro ? err({ status: 403, responseJSON: r }) : ok(r)) }
  }
  return { w, chamadas, adiadas, travas, mudar: (x) => { conf = { ...conf, ...x } } }
}
const clicar = (env, act, attrs = {}) => env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-act' ? act : attrs[k]) }) } })

test('telefone desligado por padrão: não pede credencial, não reserva o ramal, não carrega o JsSIP', async () => {
  const env = ambiente(), reg = {}
  const { w, chamadas, travas } = comVoz(env, reg, { credencial: CRED }, { voz: 'N' })
  w.callbacks.init(); env.rodarTimers(); await flush()
  assert.equal(chamadas.filter((c) => c.acao).length, 0); assert.equal(reg.n, undefined); assert.equal(travas.temDono(), false)
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /Telefone/)
})

test('telefone: registra com HA1 (sem senha), endpoint derivado, credencial fora do storage', async () => {
  const env = ambiente(), reg = {}
  const { w, chamadas } = comVoz(env, reg, { credencial: CRED }, { endpoint: 'https://x.supabase.co/functions/v1/prevendas-fila' })
  w.callbacks.init(); await flush()
  const c = chamadas.find((x) => x.acao === 'credencial')
  assert.equal(c.url, 'https://x.supabase.co/functions/v1/prevendas-voz')
  assert.equal(reg.cfg.ha1, CRED.ha1); assert.equal(reg.cfg.password, undefined); assert.equal(reg.cfg.authorization_user, '1006')
  assert.equal(reg.cfg.realm, 'ruston.api4com.com'); assert.equal(reg.cfg.sockets[0].url, CRED.wss); assert.equal(reg.started, 1)
  reg.emit('registered')
  assert.match(env.elems['rpv-root'].innerHTML, /Telefone( (4com|3C))? · pronto/)
  for (const st of [env.ctx.localStorage, env.ctx.sessionStorage]) for (const v of st._m.values()) assert.ok(!String(v).includes(CRED.ha1), 'HA1 vazou para o storage')
})

test('sem Web Locks no navegador: não registra (fail-closed)', async () => {
  const env = ambiente(), reg = {}
  const { w, chamadas } = comVoz(env, reg, { credencial: CRED })
  env.ctx.navigator = {}
  w.callbacks.init(); await flush()
  assert.equal(chamadas.filter((c) => c.acao === 'credencial').length, 0); assert.equal(reg.n, undefined)
  assert.match(env.elems['rpv-root'].innerHTML, /não controla abas/)
})

test('discar (decisão do Gabriel): atende SOZINHO a integrada da tentativa, uma vez; o resto só toca', async () => {
  const env = ambiente(), reg = {}
  const { w, chamadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: '47 99729-3673' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'
  env.rodarTimers('i')
  assert.match(env.elems['rpv-root'].innerHTML, /data-act="voz-ligar" data-tel="\+5547997293673"/)
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  const d = chamadas.find((c) => c.acao === 'discar')
  assert.deepEqual({ et: d.entity_type, id: d.entity_id, tel: d.telefone }, { et: 'leads', id: 555, tel: '+5547997293673' })
  // INVITE integrado dentro da janela da tentativa: atende sozinho
  const integrada = sessao(true); reg.emit('newRTCSession', integrada)
  assert.equal(integrada.session.atendida, true); assert.match(env.elems['rpv-root'].innerHTML, /Em chamada/)
  integrada.session.terminate()
  // segunda integrada na MESMA tentativa: a autorização já foi consumida → só toca
  const segunda = sessao(true); reg.emit('newRTCSession', segunda)
  assert.equal(segunda.session.atendida, undefined)
  segunda.session.terminate()
  // INVITE sem o header (ou não pedido): só toca, rótulo neutro
  const estranha = sessao(false); reg.emit('newRTCSession', estranha)
  assert.equal(estranha.session.atendida, undefined)
  assert.match(env.elems['rpv-root'].innerHTML, /Chamada recebida/)
})

test('pedido de discagem recusado pelo servidor: nenhuma chamada é atendida sozinha e o aviso aparece', async () => {
  const env = ambiente(), reg = {}
  const { w } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: { erro: 'sem_permissao' },
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  assert.match(env.elems['rpv-root'].innerHTML, /não é dono deste lead/)
  const inv = sessao(true); reg.emit('newRTCSession', inv)
  assert.equal(inv.session.atendida, undefined)
  assert.match(env.elems['rpv-root'].innerHTML, /Chamada recebida/)    // janela zerada pela recusa: nem rótulo de "sua ligação"
})

test('duas abas: a segunda não registra; "usar aqui" rouba a posse e a primeira desliga', async () => {
  const travas = travasFalsas()
  const A = ambiente(), regA = {}, B = ambiente(), regB = {}
  const a = comVoz(A, regA, { credencial: CRED }, {}, travas)
  a.w.callbacks.init(); await flush(); regA.emit('registered')
  const b = comVoz(B, regB, { credencial: CRED }, {}, travas)
  b.w.callbacks.init(); await flush()
  assert.equal(b.chamadas.filter((c) => c.acao === 'credencial').length, 0); assert.equal(regB.n, undefined)
  assert.match(B.elems['rpv-root'].innerHTML, /ativo em outra aba/)
  clicar(B, 'voz-aqui'); await flush()
  assert.equal(regA.stopped, 1); assert.match(A.elems['rpv-root'].innerHTML, /ativo em outra aba/)
  assert.equal(regB.started, 1)
})

test('credencial atrasada + outra aba assume no meio: a resposta velha NÃO inicia o ramal', async () => {
  const travas = travasFalsas()
  const A = ambiente(), regA = {}, B = ambiente(), regB = {}
  const a = comVoz(A, regA, { credencial: 'adiar' }, {}, travas)
  a.w.callbacks.init(); await flush()
  assert.equal(a.adiadas.length, 1)                            // A pediu a credencial e está esperando
  const b = comVoz(B, regB, { credencial: CRED }, {}, travas)
  b.w.callbacks.init(); await flush()
  clicar(B, 'voz-aqui'); await flush()                         // B rouba a posse
  assert.equal(regB.started, 1)
  a.adiadas[0].ok(CRED); await flush()                         // chega a credencial atrasada de A
  assert.equal(regA.n, undefined, 'A criou UA sem a posse')
  assert.equal(regB.stopped, undefined, 'o registro de B foi derrubado')
})

test('voz=N com o ramal ativo: desliga o UA, solta a posse e some do card no próximo tique', async () => {
  const env = ambiente(), reg = {}
  const { w, travas, mudar } = comVoz(env, reg, { credencial: CRED })
  w.callbacks.init(); await flush(); reg.emit('registered')
  assert.equal(travas.temDono(), true)
  mudar({ voz: 'N' }); w.callbacks.onSave(); await flush()
  assert.equal(reg.stopped, 1); assert.equal(travas.temDono(), false)
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /Telefone/)
  reg.emit('registered')                                        // evento atrasado do UA velho: ignorado
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /Telefone/)
})

test('destroy desliga o ramal e solta a posse', async () => {
  const env = ambiente(), reg = {}
  const { w, travas } = comVoz(env, reg, { credencial: CRED })
  w.callbacks.init(); await flush(); reg.emit('registered')
  w.callbacks.destroy(); await flush()
  assert.equal(reg.stopped, 1); assert.equal(travas.temDono(), false)
})

test('servidor pede pausa (429 nos chats): a fila vem, e a próxima leitura espera o Retry-After', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)], retry_after: 30, motivos_parcial: ['chats_limite'], parcial: true }])
  w.callbacks.init(); env.rodarTimers('t')
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
  const pausa = Number(env.ctx.localStorage.getItem('rpv_pausa_financeirorustonengenhariacombr_11420911'))
  assert.ok(pausa > Date.now() + 20000)
})

test('chat sem resposta: vai primeiro na fila e o card não oferece "Concluir"', () => {
  const env = ambiente()
  const chat = { id: -555, entity_type: 'leads', entity_id: 555, due: AGORA - 600, momento: 'chat_sem_resposta', grupo: 'G9', urgente: true, texto: 'Cliente aguardando resposta no chat', lead_nome: 'Lead chat', acao: 'chat' }
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1, { momento: 'anti_noshow' }), chat], chats_em: Math.floor(Date.now() / 1000) - 10 }])
  w.callbacks.init(); env.rodarTimers('t')
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'avancar' }) } })
  assert.equal(env.ctx.location.pathname, '/leads/detail/555')
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Responda o cliente no chat/); assert.doesNotMatch(html, /Concluir e próximo/)
})

test('chat com leitura velha (chats_em > 3 min ou ausente) não aparece nem notifica; as tarefas ficam', () => {
  const env = ambiente()
  const agora = Math.floor(Date.now() / 1000)
  const chat = { id: -9, entity_type: 'leads', entity_id: 9, due: agora - 60, momento: 'chat_sem_resposta', grupo: 'G9', urgente: true, texto: 'c', acao: 'chat' }
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), chat], chats_em: agora - 260 }])
  w.callbacks.init(); env.rodarTimers('t')
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /<span class="cnt">1<\/span>/)                 // só a tarefa
  // aba seguidora com snapshot em que o chat ERA válido, mas envelheceu
  const B = ambiente()
  const snap = { itens: [tarefa(1), chat], modo: 'servidor', dadosEm: agora - 5, chatsEm: agora - 190, rev: 'r1', v: 2, perfil: 'auto.v2' }
  B.ctx.localStorage.setItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911', JSON.stringify(snap))
  B.ctx.localStorage.setItem('rpv_lider.auto.v2_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 60000 }))
  const wb = instanciar(B, [{ ok: true, itens: [] }]); wb.callbacks.init()
  assert.match(B.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

test('INVITE NÃO integrado antes da recusa: só toca; a recusa tira o rótulo "Sua ligação"', async () => {
  const env = ambiente(), reg = {}
  const { w, adiadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  const inv = sessao(true); inv.request.getHeader = () => undefined; reg.emit('newRTCSession', inv)   // sem o header da 4com
  assert.match(env.elems['rpv-root'].innerHTML, /Chamada recebida/)
  adiadas[0].err({ status: 403, responseJSON: { erro: 'sem_permissao' } })
  const html = env.elems['rpv-root'].innerHTML
  assert.doesNotMatch(html, /Sua ligação/); assert.match(html, /Chamada recebida/); assert.match(html, /não é dono deste lead/)
  assert.equal(inv.session.atendida, undefined)
})

test('resposta de discagem de uma posse antiga não mexe na sessão nova', async () => {
  const env = ambiente(), reg = {}
  const { w, adiadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  clicar(env, 'voz-reconectar'); await flush(); reg.emit('registered')   // nova posse
  adiadas[0].err({ status: 403, responseJSON: { erro: 'sem_permissao' } })
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /não é dono deste lead/)
})

// relógio simulado dentro da VM: Date.now() = real + deslocamento
function relogio(env) {
  const Real = Date; let desloc = 0
  class D extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + desloc) } static now() { return Real.now() + desloc } }
  env.ctx.Date = D
  return { avancar: (ms) => { desloc += ms } }
}
const chatItem = (agora) => ({ id: -555, entity_type: 'leads', entity_id: 555, due: agora - 60, momento: 'chat_sem_resposta', grupo: 'G9', urgente: true, texto: 'chat', lead_nome: 'Lead chat', acao: 'chat' })

test('chat válido que ENVELHECE com o widget aberto (líder, resposta com o mesmo gerado_em): sai pelo relógio', () => {
  const env = ambiente(), rel = relogio(env)
  const agora = Math.floor(Date.now() / 1000), g = agora - 1
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1), chatItem(agora)], chats_em: agora - 179, gerado_em: g },
    { ok: true, itens: [tarefa(1)], chats_em: null, gerado_em: g },            // servidor já podou, mesmo gerado_em
  ])
  w.callbacks.init(); env.rodarTimers('t')
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">2<\/span>/)
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/555')   // ainda válido: abre o chat
  assert.match(env.elems['rpv-root'].innerHTML, /Responda o cliente no chat/)
  rel.avancar(6000); env.rodarTimers('i')                                   // 185 s: venceu; leitura com mesmo gerado_em é ignorada
  const html = env.elems['rpv-root'].innerHTML
  assert.doesNotMatch(html, /Responda o cliente no chat/); assert.match(html, /<span class="cnt">1<\/span>/)
  env.ctx.location.pathname = '/leads/pipeline'
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')    // vai para a tarefa, não para o chat
})

test('chat que envelhece em aba SEGUIDORA (snapshot sem rev nova): sai pelo relógio', () => {
  const B = ambiente(), rel = relogio(B)
  const agora = Math.floor(Date.now() / 1000)
  B.ctx.localStorage.setItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911', JSON.stringify({ itens: [tarefa(1), chatItem(agora)], modo: 'servidor', dadosEm: agora - 1, chatsEm: agora - 179, rev: 'r1', v: 2, perfil: 'auto.v2' }))
  B.ctx.localStorage.setItem('rpv_lider.auto.v2_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 3600000 }))
  const w = instanciar(B, [{ ok: true, itens: [] }]); w.callbacks.init()
  assert.match(B.elems['rpv-root'].innerHTML, /<span class="cnt">2<\/span>/)
  rel.avancar(6000); B.rodarTimers('i')
  assert.match(B.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

test('chat que envelhece DURANTE pausa do Kommo: sai pelo relógio, tarefas e dados ficam', () => {
  const env = ambiente(), rel = relogio(env)
  const agora = Math.floor(Date.now() / 1000)
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), chatItem(agora)], chats_em: agora - 179, retry_after: 300 }])
  w.callbacks.init(); env.rodarTimers('t')
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">2<\/span>/)
  let leu = false; w.$authorizedAjax = () => { leu = true; return { then() {} } }
  rel.avancar(6000); env.rodarTimers('i')
  assert.equal(leu, false)                                                   // pausado: não lê
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

test('modo closer (servidor): "Concluir" vai para OUTRO lead (não reapresenta o mesmo em loop)', () => {
  const env = ambiente()
  const agora = Math.floor(Date.now() / 1000)
  const ct = (id, eid, extra = {}) => ({ id, entity_type: 'leads', entity_id: eid, due: agora - 600 + id, momento: 'follow_up', grupo: 'G9', texto: 't' + id, pipeline_id: 11010459, status_id: 102174784, ...extra })
  const w = instanciar(env, [{ ok: true, modo: 'closer', itens: [ct(1, 10), ct(2, 10), ct(3, 20, { status_id: 102174776 })], chats_em: agora }])
  let patch = null
  env.ctx.__kommo = (o) => { patch = o; return { done(fn) { fn({}); return this }, fail() { return this } } }
  w.callbacks.init(); env.rodarTimers('t')
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">2<\/span>/)          // 2 leads, não 3 tarefas
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')
  assert.match(env.elems['rpv-root'].innerHTML, /\+1<\/span>/)                         // +1 pendente no lead 10
  clicar(env, 'concluir')
  assert.match(patch.url, /\/api\/v4\/tasks\/1$/)                                      // só a tarefa exibida
  assert.equal(env.ctx.location.pathname, '/leads/detail/20')                         // próximo LEAD
})

test('setting modo vai no pedido ao servidor (o servidor só aceita de gestor)', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [] }], { modo: 'closer' })
  let corpo = null; w.$authorizedAjax = (o) => { corpo = JSON.parse(o.data); return { then() {} } }
  w.callbacks.init(); env.rodarTimers('t')
  assert.deepEqual(corpo, { forcar: false, modo: 'closer' })
})

// ---------------- closer: card por entidade, degradado e isolamento por perfil (rodada do Vedor) ----------------
const ctC = (agora, id, eid, extra = {}) => ({ id, entity_type: 'leads', entity_id: eid, due: agora - 600 + id, momento: 'follow_up', grupo: 'G9', texto: 't' + id, pipeline_id: 11010459, status_id: 102174784, ...extra })

for (const [nome, segunda] of [
  ['compromisso', (a) => [ctC(a, 1, 10), ctC(a, 2, 10, { reuniao_em: a + 1800 }), ctC(a, 3, 20)].map((x) => (x.entity_id === 10 ? { ...x, reuniao_em: a + 1800 } : x))],
  ['chat', (a) => [ctC(a, 1, 10), { id: -10, entity_type: 'leads', entity_id: 10, due: a - 30, momento: 'chat_sem_resposta', grupo: 'G9', urgente: true, texto: 'c', acao: 'chat' }, ctC(a, 3, 20)]],
]) {
  test(`closer: a representativa do lead aberto muda (${nome}) — o card continua e age na NOVA representativa`, () => {
    const env = ambiente()
    const a = Math.floor(Date.now() / 1000)
    const w = instanciar(env, [
      { ok: true, modo: 'closer', itens: [ctC(a, 1, 10), ctC(a, 2, 10), ctC(a, 3, 20)], chats_em: a },
      { ok: true, modo: 'closer', itens: segunda(a), chats_em: a },
    ])
    let patch = null
    env.ctx.__kommo = (o) => { patch = o; return { done(fn) { fn({}); return this }, fail() { return this } } }
    w.callbacks.init(); env.rodarTimers('t')
    clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')
    env.rodarTimers('i')                                                  // nova leitura: representativa do lead 10 mudou
    const html = env.elems['rpv-root'].innerHTML
    if (nome === 'chat') { assert.match(html, /Responda o cliente no chat/); return }
    assert.match(html, /Concluir e próximo/)
    clicar(env, 'concluir'); assert.match(patch.url, /\/tasks\/2$/)       // a nova representativa (mais perto da reunião)
  })
}

test('closer + servidor cai: o degradado mantém o modo closer (2 leads, não 3 tarefas) e as marcas por lead', () => {
  const env = ambiente()
  const a = Math.floor(Date.now() / 1000)
  const w = instanciar(env, [{ ok: true, modo: 'closer', itens: [ctC(a, 1, 10), ctC(a, 2, 10), ctC(a, 3, 20)], chats_em: a, gerado_em: a - 120 }, { erro: 'falha_banco', status: 503 }])
  let fase = 'patch'
  env.ctx.__kommo = (o) => {
    if (o.method === 'GET' && /\/api\/v4\/tasks\/\d+$/.test(o.url)) return { done(fn) { fn({ ...viva(1), entity_type: 'leads', entity_id: 10 }); return this }, fail() { return this } }   // conferência ao vivo antes do PATCH
    if (fase === 'patch' || o.method === 'PATCH') return { done(fn) { fn({}); return this }, fail() { return this } }
    return { done(fn) { fn({ _embedded: { tasks: [1, 2, 3].map((id) => ({ id, entity_type: 'leads', entity_id: id < 3 ? 10 : 20, complete_till: a - 600 + id, text: 't' })) } }, 'ok', { status: 200 }); return this }, fail() { return this } }
  }
  w.callbacks.init(); env.rodarTimers('t')
  clicar(env, 'avancar')
  fase = 'degradado'                                                    // a releitura logo após concluir: servidor 503 → sessão (ainda traz a 1)
  clicar(env, 'concluir')                                              // conclui a 1 do lead 10 → vai ao 20
  assert.equal(env.ctx.location.pathname, '/leads/detail/20')
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /<span class="cnt">1<\/span>/)                      // lead 10 segue marcado; só o 20
  clicar(env, 'painel'); assert.match(env.elems['rpv-root'].innerHTML, /etapa a confirmar/)
})

test('degradado sem modo confirmado: avisa e mostra como SDR', () => {
  const env = ambiente()
  env.ctx.__kommo = () => ({ done(fn) { fn({ _embedded: { tasks: [{ id: 7, entity_type: 'leads', entity_id: 70, complete_till: AGORA - 10, text: 'x' }] } }, 'ok', { status: 200 }); return this }, fail() { return this } })
  const w = instanciar(env, [{ erro: 'jwt_conta', status: 401 }])
  w.callbacks.init(); env.rodarTimers()
  clicar(env, 'painel')
  assert.match(env.elems['rpv-root'].innerHTML, /Modo da fila ainda não confirmado/)
})

test('isolamento por perfil: snapshot closer de outra aba NÃO serve a esta aba com override sdr; versão antiga é ignorada', () => {
  const env = ambiente()
  const a = Math.floor(Date.now() / 1000)
  const snapCloser = { itens: [ctC(a, 1, 10), ctC(a, 2, 10)], modo: 'servidor', modoFila: 'closer', dadosEm: a - 1, chatsEm: a, rev: 'rc', v: 2, perfil: 'auto.v2' }
  env.ctx.localStorage.setItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911', JSON.stringify(snapCloser))
  env.ctx.localStorage.setItem('rpv_lider.auto.v2_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 3600000 }))
  env.ctx.localStorage.setItem('rpv_snap.sdr.v2_financeirorustonengenhariacombr_11420911', JSON.stringify({ ...snapCloser, perfil: 'sdr.v1', v: 1 }))   // versão antiga
  const w = instanciar(env, [{ ok: true, modo: 'sdr', itens: [ctC(a, 1, 10), ctC(a, 2, 10), ctC(a, 3, 20)] }], { modo: 'sdr' })
  let chamou = 0; const orig = w.$authorizedAjax; w.$authorizedAjax = (o) => { chamou++; return orig(o) }
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(chamou, 1)                                                  // lidera o PRÓPRIO perfil e lê o servidor
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">3<\/span>/)   // fila SDR: 3 tarefas
})

test('troca de override com leitura PENDENTE: a resposta antiga (closer) não contamina o perfil novo (sdr)', () => {
  const env = ambiente()
  const a = Math.floor(Date.now() / 1000)
  let conf = { endpoint: 'https://srv/fila', usuarios: '11420911' }
  const w = instanciar(env, [{ ok: true, itens: [] }]); w.get_settings = () => conf
  const pend = []
  w.$authorizedAjax = (o) => { const b = JSON.parse(o.data); return { then: (ok, err) => pend.push({ b, ok, err }) } }
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(pend.length, 1); assert.equal(pend[0].b.modo, undefined)                // leitura em "auto"
  conf = { ...conf, modo: 'sdr' }; w.callbacks.onSave()                                 // troca para sdr antes da resposta
  assert.equal(pend.length, 2); assert.equal(pend[1].b.modo, 'sdr')                     // nova leitura, já no perfil novo
  pend[0].ok({ ok: true, modo: 'closer', itens: [ctC(a, 1, 10), ctC(a, 2, 10), ctC(a, 3, 20)], gerado_em: a })   // chega a antiga
  assert.equal(env.ctx.localStorage.getItem('rpv_snap.sdr.v2_financeirorustonengenhariacombr_11420911'), null)
  assert.equal(env.ctx.localStorage.getItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'), null)
  pend[1].ok({ ok: true, modo: 'sdr', itens: [ctC(a, 1, 10), ctC(a, 2, 10), ctC(a, 3, 20)], gerado_em: a })
  const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap.sdr.v2_financeirorustonengenhariacombr_11420911'))
  assert.equal(snap.modoFila, 'sdr'); assert.equal(snap.perfil, 'sdr.v2')
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">3<\/span>/)        // 3 tarefas SDR
  assert.equal(env.ctx.localStorage.getItem('rpv_lider.auto.v2_financeirorustonengenhariacombr_11420911'), 'null')   // liderança antiga solta
})

test('troca de override DURANTE o degradado: a leitura pela sessão antiga é descartada', () => {
  const env = ambiente()
  const a = Math.floor(Date.now() / 1000)
  let conf = { endpoint: 'https://srv/fila', usuarios: '11420911' }
  const w = instanciar(env, [{ erro: 'falha_banco', status: 503 }]); w.get_settings = () => conf
  const sessao = []
  env.ctx.__kommo = () => ({ done(fn) { sessao.push(fn); return this }, fail() { return this } })
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(sessao.length, 1)                                                        // degradado pendente
  conf = { ...conf, modo: 'closer' }; w.callbacks.onSave()
  sessao[0]({ _embedded: { tasks: [{ id: 1, entity_type: 'leads', entity_id: 10, complete_till: a - 10, text: 'x' }] } }, 'ok', { status: 200 })
  assert.equal(env.ctx.localStorage.getItem('rpv_snap.closer.v2_financeirorustonengenhariacombr_11420911'), null)
  assert.equal(env.ctx.localStorage.getItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'), null)
})

// ---------------- hotfix 0.4.1 (af370ad), trazido para a branch da fila do closer ----------------
test('telefone: número de TESTE do servidor aparece com "Ligar"; telefone em formato não reconhecido é avisado', async () => {
  const env = ambiente(), reg = {}
  const { w } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Marcia', telefones: [], invalidos: 1 }], teste: ['+5547997293673'] },
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /formato que não reconheço/)
  assert.match(html, /Número de TESTE/); assert.match(html, /data-act="voz-ligar" data-tel="\+5547997293673"/)
})

test('relógio do PC adiantado 2 min: a leitura do servidor NÃO aparece como desatualizada', () => {
  const env = ambiente()
  const Real = Date, desloc = 120000
  env.ctx.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + desloc) } static now() { return Real.now() + desloc } }
  const servidor = Math.floor(Real.now() / 1000)                       // relógio do servidor (certo)
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)], gerado_em: servidor - 5, servidor_agora: servidor, chats_em: servidor - 10 }])
  w.callbacks.init(); env.rodarTimers('t')
  clicar(env, 'painel')
  const html = env.elems['rpv-root'].innerHTML
  assert.doesNotMatch(html, /Fila desatualizada/); assert.match(html, /Concluir|Próximo/)
  const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'))
  assert.equal(snap.dadosEm, servidor - 5)                             // carimbo BRUTO (identidade/ordem)
  const d = JSON.parse(env.ctx.localStorage.getItem('rpv_desvio_financeirorustonengenhariacombr_11420911'))
  assert.ok(Math.abs(d.s - 120) <= 1)                                  // o desvio do PC fica guardado à parte
})

function pcAdiantado(env, ms) {
  const Real = Date
  env.ctx.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + ms) } static now() { return Real.now() + ms } }
}

test('PC +120 s: tarefa que vence em 11 min continua FUTURA (antecedência 10 min) — prazo e "agora" no mesmo referencial', () => {
  const env = ambiente(); pcAdiantado(env, 120000)
  const S = Math.floor(Date.now() / 1000)
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1, { due: S + 11 * 60 })], gerado_em: S - 1, servidor_agora: S }])
  w.callbacks.init(); env.rodarTimers('t')
  const html = env.elems['rpv-root'].innerHTML
  assert.doesNotMatch(html, /<span class="cnt">/); assert.match(html, /Próxima/)    // nada vencido; oferece a futura
})

test('mesmo cache depois de uma falha, com latência diferente: NÃO limpa a falha (identidade pelo carimbo bruto)', () => {
  const env = ambiente(); pcAdiantado(env, 120000)
  const S = Math.floor(Date.now() / 1000)
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1)], gerado_em: S, servidor_agora: S },
    { erro: 'falha_banco', status: 503 },
    { ok: true, itens: [tarefa(1)], gerado_em: S, servidor_agora: S - 2 },     // o MESMO cache, com mais trânsito que a 1ª leitura
  ])
  w.callbacks.init(); env.rodarTimers('t')
  env.rodarTimers('i')                                                         // 503 e sessão falha → falha registrada
  env.rodarTimers('i')                                                         // chega o cache igual
  clicar(env, 'painel')
  assert.match(env.elems['rpv-root'].innerHTML, /Não consegui atualizar a fila/)
})

test('degradado com leitura parcial SEM motivo: o aviso de fila parcial aparece', () => {
  const env = ambiente()
  env.ctx.__kommo = () => ({ done(fn) { fn({ _embedded: { tasks: Array.from({ length: 250 }, (_, i) => ({ id: i + 1, entity_type: 'leads', entity_id: 9000 + i, complete_till: AGORA - 10, text: 'x' })) } }, 'ok', { status: 200 }); return this }, fail() { return this } })
  const w = instanciar(env, [{ erro: 'jwt_conta', status: 401 }])
  w.callbacks.init(); for (let i = 0; i < 6; i++) env.rodarTimers('t')    // páginas do degradado encadeadas por setTimeout
  clicar(env, 'painel')
  assert.match(env.elems['rpv-root'].innerHTML, /Fila parcial: algumas tarefas podem faltar/)
})

// relógio do PC deslocado e avançável (o "servidor" é o relógio real + avanço)
function pcRelogio(env, deslocMs) {
  const Real = Date; let avanco = 0
  env.ctx.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + deslocMs + avanco) } static now() { return Real.now() + deslocMs + avanco } }
  return { avancar: (ms) => { avanco += ms }, servidor: () => Math.floor((Real.now() + avanco) / 1000) }
}

for (const desloc of [120000, -120000]) {
  test(`1ª calibração (PC ${desloc > 0 ? '+' : ''}${desloc / 1000} s): falha local anterior NÃO bloqueia a leitura nova do servidor; cache anterior à falha segue rejeitado`, () => {
    const env = ambiente(), rel = pcRelogio(env, desloc)
    const S = rel.servidor()
    const w = instanciar(env, [{ erro: 'falha_banco', status: 503 }])
    w.callbacks.init(); env.rodarTimers('t')                                  // servidor 503 + sessão falha → falha (carimbo local, sem desvio)
    let resp = null; w.$authorizedAjax = () => ({ then: (ok) => ok(resp) })
    rel.avancar(5000)
    resp = { ok: true, itens: [tarefa(1)], gerado_em: S - 30, servidor_agora: S + 5 }   // cache ANTERIOR à falha
    env.rodarTimers('i'); clicar(env, 'painel')
    assert.match(env.elems['rpv-root'].innerHTML, /Não consegui atualizar a fila/)
    rel.avancar(5000)
    resp = { ok: true, itens: [tarefa(1)], gerado_em: S + 9, servidor_agora: S + 10 }  // leitura NOVA, posterior à falha
    env.rodarTimers('i')
    const html = env.elems['rpv-root'].innerHTML
    assert.doesNotMatch(html, /Não consegui atualizar a fila/); assert.doesNotMatch(html, /desatualizada/)
  })

  test(`1ª calibração (PC ${desloc > 0 ? '+' : ''}${desloc / 1000} s): dados do degradado não barram a leitura nova do servidor`, () => {
    const env = ambiente(), rel = pcRelogio(env, desloc)
    const S = rel.servidor()
    env.ctx.__kommo = () => ({ done(fn) { fn({ _embedded: { tasks: [{ id: 77, entity_type: 'leads', entity_id: 770, complete_till: S - 10, text: 'x' }] } }, 'ok', { status: 200 }); return this }, fail() { return this } })
    const w = instanciar(env, [{ erro: 'falha_banco', status: 503 }])
    w.callbacks.init(); env.rodarTimers('t')                                  // degradado com sucesso (dadosEm local)
    let resp = null; w.$authorizedAjax = () => ({ then: (ok) => ok(resp) })
    rel.avancar(3000)
    resp = { ok: true, itens: [tarefa(1)], gerado_em: S + 2, servidor_agora: S + 3 }
    env.rodarTimers('i')
    const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'))
    assert.equal(snap.modo, 'servidor'); assert.deepEqual(snap.itens.map((t) => t.id), [1])
  })
}

// PC com deslocamento AJUSTÁVEL (simula o acerto do relógio do PC) e avanço do tempo real
function pcAjustavel(env, deslocMs) {
  const Real = Date; let avanco = 0, desloc = deslocMs
  env.ctx.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + desloc + avanco) } static now() { return Real.now() + desloc + avanco } }
  return { avancar: (ms) => { avanco += ms }, acertar: (ms) => { desloc = ms }, servidor: () => Math.floor((Real.now() + avanco) / 1000) }
}

test('PC acertado DEPOIS da calibração: a falha já alinhada não se move e a leitura nova libera as ações', () => {
  const env = ambiente(), rel = pcAjustavel(env, 600000)
  const S = rel.servidor()
  let resp = { ok: true, itens: [tarefa(1)], gerado_em: S, servidor_agora: S }
  const w = instanciar(env, [{ ok: true, itens: [] }]); w.$authorizedAjax = () => ({ then: (ok, err) => (resp.erro ? err({ status: 503, responseJSON: resp }) : ok(resp)) })
  w.callbacks.init(); env.rodarTimers('t')                                  // calibra: desvio 600
  rel.avancar(1000); resp = { erro: 'falha_banco' }; env.rodarTimers('i')  // falha em S+1 (alinhada, d=600)
  clicar(env, 'painel'); assert.match(env.elems['rpv-root'].innerHTML, /Não consegui atualizar a fila/)
  rel.acertar(0); rel.avancar(1000)                                         // o PC é acertado para a hora real
  resp = { ok: true, itens: [tarefa(1)], gerado_em: S + 2, servidor_agora: S + 2 }
  env.rodarTimers('i')
  const html = env.elems['rpv-root'].innerHTML
  assert.doesNotMatch(html, /Não consegui atualizar a fila/); assert.doesNotMatch(html, /desatualizada/)
})

test('outra aba calibra DURANTE o GET degradado: o carimbo usa o instante e a marca do INÍCIO; a leitura nova do servidor é aceita', () => {
  const env = ambiente(), rel = pcAjustavel(env, 120000)
  const S = rel.servidor()
  const sessao = []
  env.ctx.__kommo = () => ({ done(fn) { sessao.push(fn); return this }, fail() { return this } })
  let resp = { erro: 'falha_banco' }
  const w = instanciar(env, [{ ok: true, itens: [] }]); w.$authorizedAjax = () => ({ then: (ok, err) => (resp.erro ? err({ status: 503, responseJSON: resp }) : ok(resp)) })
  w.callbacks.init(); env.rodarTimers('t')                                  // 503 → GET degradado começa SEM calibração
  env.ctx.localStorage.setItem('rpv_desvio_financeirorustonengenhariacombr_11420911', JSON.stringify({ s: 120, amostras: [120] }))   // outra aba calibrou
  sessao[0]({ _embedded: { tasks: [{ id: 77, entity_type: 'leads', entity_id: 770, complete_till: S - 10, text: 'x' }] } }, 'ok', { status: 200 })
  const deg = JSON.parse(env.ctx.localStorage.getItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'))
  assert.equal(deg.modo, 'degradado'); assert.ok(Math.abs(deg.dadosEm - S) <= 1); assert.equal(deg.dLocal, 120)
  rel.avancar(3000); resp = { ok: true, itens: [tarefa(1)], gerado_em: S + 3, servidor_agora: S + 3 }
  env.rodarTimers('i')
  const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap.auto.v2_financeirorustonengenhariacombr_11420911'))
  assert.equal(snap.modo, 'servidor'); assert.deepEqual(snap.itens.map((t) => t.id), [1])
})

// ---------------- 0.4.2 (739688f): atendimento automático da tentativa ----------------
test('sem pedido de discagem, a integrada só toca (não atende sozinha)', async () => {
  const env = ambiente(), reg = {}
  const { w } = comVoz(env, reg, { credencial: CRED })
  w.callbacks.init(); await flush(); reg.emit('registered')
  const semPedido = sessao(true); reg.emit('newRTCSession', semPedido)
  assert.equal(semPedido.session.atendida, undefined)
})

for (const [nome, saltoPC, decorrido, esperado] of [
  ['PC acertado para TRÁS após 61 s reais: não amplia a janela (só toca)', -120000, 61000, undefined],
  ['PC salta para a FRENTE com 30 s reais: a janela continua valendo (atende)', 200000, 30000, true],
]) {
  test(`atendimento automático usa relógio monotônico — ${nome}`, async () => {
    const env = ambiente(), reg = {}
    const Real = Date; let desloc = 120000, perf = 1000
    env.ctx.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(Real.now() + desloc) } static now() { return Real.now() + desloc } }
    env.ctx.performance = { now: () => perf }
    const { w } = comVoz(env, reg, {
      credencial: CRED,
      telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
      discar: 'adiar',
    })
    w.callbacks.init(); await flush(); reg.emit('registered')
    env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
    clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
    perf += decorrido; desloc += saltoPC                       // passa o tempo real e o relógio do PC salta
    const inv = sessao(true); reg.emit('newRTCSession', inv)
    assert.equal(inv.session.atendida, esperado)
  })
}

// ---------------- 3C no mesmo módulo ----------------
test('3C: provedor_voz vai nos pedidos; a chamada do 3cplus na tentativa atende sozinha; outra origem só toca', async () => {
  const env = ambiente(), reg = {}
  const CRED3C = { ...CRED, provedor: '3c', wss: 'wss://vox-socket.3c.plus:4443', dominio: 'gbsvendas.3c.plus', realm: 'gbsvendas.3c.plus', ramal: '999123', uri: 'sip:999123@gbsvendas.3c.plus' }
  const { w, chamadas } = comVoz(env, reg, {
    credencial: CRED3C,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  }, { provedor_voz: '3c' })
  w.callbacks.init(); await flush(); reg.emit('registered')
  assert.equal(chamadas.find((c) => c.acao === 'credencial').provedor, '3c')
  assert.equal(reg.cfg.sockets[0].url, 'wss://vox-socket.3c.plus:4443')
  assert.match(env.elems['rpv-root'].innerHTML, /Telefone 3C · pronto/)
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  assert.equal(chamadas.find((c) => c.acao === 'discar').provedor, '3c')
  const de = (user) => { const x = sessao(false); x.request.from = { uri: { user } }; return x }
  const outra = de('5547999990000'); reg.emit('newRTCSession', outra)
  assert.equal(outra.session.atendida, undefined); outra.session.terminate()
  const integrada = de('3cplus'); reg.emit('newRTCSession', integrada)
  assert.equal(integrada.session.atendida, true)
})

test('trocar provedor_voz nas settings registra o ramal de novo (credencial do provedor novo)', async () => {
  const env = ambiente(), reg = {}
  const { w, chamadas, mudar } = comVoz(env, reg, { credencial: (b) => ({ ...CRED, provedor: b.provedor === '3c' ? '3c' : '4com' }) })
  w.callbacks.init(); await flush(); reg.emit('registered')
  assert.equal(chamadas.filter((c) => c.acao === 'credencial').length, 1)
  mudar({ provedor_voz: '3c' }); w.callbacks.onSave(); await flush()      // solta o ramal 4com
  env.rodarTimers('i'); await flush()
  const creds = chamadas.filter((c) => c.acao === 'credencial')
  assert.equal(creds.length, 2); assert.equal(creds[1].provedor, '3c'); assert.ok(reg.stopped >= 1)
})

// ---------------- 0.4.4: ajustes do T2 ----------------
test('0.4.4: em chamada some o "Chamando…"; ramal registrado em outro lugar é avisado; sem INVITE em 25 s, orienta', async () => {
  const env = ambiente(), reg = {}
  const { w } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush()
  reg.emit('registered', { response: { getHeaders: () => ['<sip:1006@abc.invalid;transport=ws>;expires=300', '<sip:1006@10.0.0.5:5060>;expires=600'] } })
  assert.match(env.elems['rpv-root'].innerHTML, /também está registrado em outro lugar/)
  reg.emit('registered', { response: { getHeaders: () => ['<sip:1006@abc.invalid;transport=ws>;expires=300'] } })
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /também está registrado/)
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  assert.match(env.elems['rpv-root'].innerHTML, /Chamando…/)
  env.rodarTimers('t')                                                       // 25 s sem INVITE
  assert.match(env.elems['rpv-root'].innerHTML, /não chegou a este telefone/)
  const inv = sessao(true); reg.emit('newRTCSession', inv)                   // chega (ainda na janela de 60 s)
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Em chamada/); assert.doesNotMatch(html, /Chamando…|não chegou/)
})

test('0.4.4: a orientação "não chegou" persiste ao 200 tardio SEM INVITE; timer atrasado além da janela não orienta', async () => {
  const env = ambiente(), reg = {}
  let perf = 1000; env.ctx.performance = { now: () => perf }
  const { w, adiadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  perf += 25000; env.rodarTimers('t')                                     // 25 s sem INVITE
  assert.match(env.elems['rpv-root'].innerHTML, /não chegou a este telefone/)
  adiadas[0].ok({ ok: true, chamada_id: 'c1' })                            // 200 tardio, ainda sem INVITE (atendida em outro lugar)
  assert.match(env.elems['rpv-root'].innerHTML, /não chegou a este telefone/)
  // nova tentativa com timer atrasado (aba suspensa): o timer só roda depois da janela de 60 s
  w.callbacks.init(); clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /não chegou/)      // tentativa nova limpa
  perf += 61000; env.rodarTimers('t')
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /não chegou/)
})

test('0.4.4: "has been failed" explica o outro registro do ramal; 2º INVITE com chamada ativa é recusado e a 1ª segue', async () => {
  const env = ambiente(), reg = {}
  let perfT = 1000; env.ctx.performance = { now: () => perfT }
  const { w, adiadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  adiadas[0].err({ status: 502, responseJSON: { erro: 'provedor_recusou', mensagem: 'call from 1006 to +5547997293673 has been failed' } })
  assert.match(env.elems['rpv-root'].innerHTML, /outro registro do seu ramal/)
  perfT += 1500                                                              // anti duplo clique (1 s)
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  const a = sessao(true); reg.emit('newRTCSession', a)
  assert.equal(a.session.atendida, true)
  const b = sessao(true); let recusada = null; b.session.terminate = (o) => { recusada = o }; reg.emit('newRTCSession', b)
  assert.equal(recusada && recusada.status_code, 486); assert.equal(b.session.atendida, undefined)
  assert.match(env.elems['rpv-root'].innerHTML, /Em chamada/)                // a primeira continua
})

test('notificações iguais do mesmo lead aparecem num card só e "×" fecha o grupo', () => {
  const env = ambiente()
  const agora = Math.floor(Date.now() / 1000)
  const t = (id) => ({ id, entity_type: 'leads', entity_id: 777, due: agora - 60, momento: 'sem_classificacao', grupo: 'G9', texto: 'CONEXÃO — igual', lead_nome: 'X' })
  const w = instanciar(env, [{ ok: true, itens: [t(1), t(2)] }])
  w.callbacks.init(); env.rodarTimers('t')
  let html = env.elems['rpv-root'].innerHTML
  assert.equal((html.match(/rpv-ntf/g) || []).length, 1); assert.match(html, /2 iguais/)
  clicar(env, 'fechar-ntf', { 'data-tid': '1,2' })
  html = env.elems['rpv-root'].innerHTML
  assert.equal((html.match(/rpv-ntf/g) || []).length, 0)
})

// ---------------- 0.4.5: sem trava de 20 s + discador manual ----------------
test('0.4.5: nova tentativa substitui a pendente; duplo clique (< 1 s) é ignorado; em chamada não disca', async () => {
  const env = ambiente(), reg = {}
  let perfT = 1000; env.ctx.performance = { now: () => perfT }
  const { w, chamadas, adiadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  const discagens = () => chamadas.filter((c) => c.acao === 'discar').length
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })              // duplo clique
  assert.equal(discagens(), 1)
  perfT += 1500; clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })   // nova tentativa com a anterior pendente
  assert.equal(discagens(), 2)
  adiadas[0].err({ status: 502, responseJSON: { erro: 'provedor_recusou', mensagem: 'velha' } })   // resposta da 1ª: ignorada
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /velha|não completou/)
  const inv = sessao(true); reg.emit('newRTCSession', inv)                // a chamada da 2ª chega e atende sozinha
  assert.equal(inv.session.atendida, true)
  perfT += 1500; clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })   // em chamada: não disca
  assert.equal(discagens(), 2)
})

test('0.4.5: discador manual manda manual:true com o lead aberto; número inválido é recusado; o digitado sobrevive ao render', async () => {
  const env = ambiente(), reg = {}
  let perfT = 1000; env.ctx.performance = { now: () => perfT }
  const { w, chamadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [] },
    discar: (b) => (b.telefone === '123' ? { erro: 'telefone_invalido' } : { ok: true, chamada_id: 'm1' }),
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  assert.match(env.elems['rpv-root'].innerHTML, /id="rpv-manual"/)          // aparece mesmo fora de um lead
  const digitar = env.ouvintes.find((o) => o[0] === 'input')[1]
  digitar({ target: { id: 'rpv-manual', value: '47 99729-3673' } })
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  assert.match(env.elems['rpv-root'].innerHTML, /value="47 99729-3673"/)    // sobreviveu ao render
  clicar(env, 'voz-manual')
  const d = chamadas.find((c) => c.acao === 'discar')
  assert.deepEqual({ m: d.manual, t: d.telefone, et: d.entity_type, id: d.entity_id }, { m: true, t: '47 99729-3673', et: 'leads', id: 555 })
  perfT += 1500
  digitar({ target: { id: 'rpv-manual', value: '123' } }); clicar(env, 'voz-manual')
  assert.match(env.elems['rpv-root'].innerHTML, /Número inválido/)
})

test('0.4.5: ao discar re-registra o ramal e só pede a discagem após o REGISTER confirmar (ou em 2,5 s)', async () => {
  const env = ambiente(), reg = {}
  let perfT = 1000; env.ctx.performance = { now: () => perfT }
  const { w, chamadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush()
  let registros = 0; reg.ua.register = () => { registros++ }
  reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  const discagens = () => chamadas.filter((c) => c.acao === 'discar').length
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  assert.equal(registros, 1); assert.equal(discagens(), 0)               // esperando o REGISTER
  reg.emit('registered')                                                  // confirmou: agora pede
  assert.equal(discagens(), 1)
  perfT += 1500; clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  assert.equal(registros, 2); assert.equal(discagens(), 1)
  env.rodarTimers('t')                                                     // REGISTER não confirmou: segue em 2,5 s
  assert.equal(discagens(), 2)
})

test('0.4.5: chamada atendida durante a espera do REGISTER cancela a discagem (nem a confirmação nem o fallback enviam)', async () => {
  const env = ambiente(), reg = {}
  let perfT = 1000; env.ctx.performance = { now: () => perfT }
  const { w, chamadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush()
  reg.ua.register = () => {}
  reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })              // espera o REGISTER
  const avulsa = sessao(false); reg.emit('newRTCSession', avulsa)          // chega uma chamada avulsa
  clicar(env, 'voz-atender')                                               // o usuário atende
  reg.emit('registered')                                                   // REGISTER confirma depois
  env.rodarTimers('t')                                                     // e o fallback também vence
  assert.equal(chamadas.filter((c) => c.acao === 'discar').length, 0)
  assert.match(env.elems['rpv-root'].innerHTML, /Em chamada/)
})

// ---------------- 0.4.6: fila nunca prende o usuário ----------------
test('Concluir com lista velha: tarefa já concluída no Kommo NÃO é concluída de novo — sai da lista e segue', () => {
  const env = ambiente()
  let patches = 0
  kommo(env, (o) => {
    if (o.method === 'PATCH') { patches++; return { status: 200, body: {} } }
    if (o.method === 'GET' && /\/api\/v4\/tasks\/1$/.test(o.url)) return { status: 200, body: { ...viva(1), is_completed: true } }
    return { status: 0 }
  })
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), tarefa(2)], gerado_em: AGORA - 600 }])
  w.callbacks.init(); env.rodarTimers('t')
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')
  clicar(env, 'concluir')
  assert.equal(patches, 0)
  assert.deepEqual(JSON.parse(env.ctx.localStorage.getItem(SNAP)).itens.map((t) => t.id), [2])
  assert.equal(env.ctx.location.pathname, '/leads/detail/20')
})

test('Concluir: tarefa reatribuída a outra pessoa no Kommo não é concluída', () => {
  const env = ambiente()
  let patches = 0
  kommo(env, (o) => {
    if (o.method === 'PATCH') { patches++; return { status: 200, body: {} } }
    if (o.method === 'GET' && /\/api\/v4\/tasks\/1$/.test(o.url)) return { status: 200, body: { ...viva(1), responsible_user_id: 999 } }
    return { status: 0 }
  })
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)] }])
  w.callbacks.init(); env.rodarTimers('t')
  clicar(env, 'avancar'); clicar(env, 'concluir')
  assert.equal(patches, 0); assert.equal(JSON.parse(env.ctx.localStorage.getItem(SNAP)).itens.length, 0)
})

test('em_andamento sem snapshot no servidor: nova tentativa em ~7 s (não espera o ciclo de 45 s)', () => {
  const env = ambiente()
  const w = instanciar(env, [])
  let n = 0
  w.$authorizedAjax = () => { n++; return { then: (ok, err) => (n === 1 ? err({ status: 503, responseJSON: { erro: 'em_andamento', retry_after: 3 } }) : ok({ ok: true, itens: [tarefa(1)], gerado_em: AGORA })) } }
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(n, 1)
  const re = [...env.timers.values()].find((t) => !t.i && t.ms === 7000)
  assert.ok(re, 'agendou a nova tentativa')
  env.ctx.localStorage.setItem('rpv_pausa_financeirorustonengenhariacombr_11420911', '0')   // a pausa curta (5 s) já passou
  re.fn()
  assert.equal(n, 2); assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

test('snapshot em_andamento (outra aba/navegador montando): publica com a idade real e agenda nova tentativa curta', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)], em_andamento: true, gerado_em: AGORA - 50 }])
  w.callbacks.init(); env.rodarTimers('t')
  assert.equal(JSON.parse(env.ctx.localStorage.getItem(SNAP)).dadosEm, AGORA - 50)
  assert.ok([...env.timers.values()].some((t) => !t.i && t.ms === 7000))
})

test('watchdog: pedido que nunca volta não congela a fila — depois de 45 s o ciclo pede de novo', () => {
  const env = ambiente(), rel = relogio(env)
  const w = instanciar(env, [])
  let n = 0
  w.$authorizedAjax = () => { n++; return { then() {} } }             // nunca resolve
  w.callbacks.init(); env.rodarTimers('t'); assert.equal(n, 1)
  rel.avancar(30000); env.ctx.localStorage.setItem('rpv_lider_financeirorustonengenhariacombr_11420911', 'null'); env.rodarTimers('i')
  assert.equal(n, 1)                                                  // ainda dentro da janela: não duplica
  rel.avancar(20000); env.ctx.localStorage.setItem('rpv_lider_financeirorustonengenhariacombr_11420911', 'null'); env.rodarTimers('i')
  assert.equal(n, 2)
})

test('erro dentro do tratamento da resposta não deixa o ciclo preso em "carregando"', () => {
  const env = ambiente()
  const w = instanciar(env, [])
  let n = 0
  w.$authorizedAjax = () => { n++; return { then: (ok) => ok(n === 1 ? { ok: true, get itens() { throw new Error('quebrado') }, gerado_em: AGORA } : { ok: true, itens: [tarefa(1)], gerado_em: AGORA + 1 }) } }
  w.callbacks.init(); env.rodarTimers('t'); assert.equal(n, 1)
  env.rodarTimers('i')
  assert.equal(n, 2); assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

for (const [nome, envelope] of [
  ['vinculada a OUTRO lead', { entity_id: 999 }],
  ['vinculada a um CONTATO (tipo diferente)', { entity_type: 'contacts' }],
  ['envelope sem entidade', { entity_type: undefined, entity_id: undefined }],
  ['envelope de OUTRA tarefa', { id: 2 }],
  ['is_completed ausente', { is_completed: undefined }],
]) {
  test('Concluir: tarefa aberta e do SDR, mas ' + nome + ' → NÃO conclui; o card sai', () => {
    const env = ambiente()
    let patches = 0
    kommo(env, (o) => {
      if (o.method === 'PATCH') { patches++; return { status: 200, body: {} } }
      if (o.method === 'GET' && /\/api\/v4\/tasks\/1$/.test(o.url)) return { status: 200, body: { ...viva(1), entity_type: 'leads', entity_id: 10, ...envelope } }
      return { status: 0 }
    })
    const w = instanciar(env, [{ ok: true, itens: [tarefa(1), tarefa(2)] }])
    w.callbacks.init(); env.rodarTimers('t')
    clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')
    clicar(env, 'concluir')
    assert.equal(patches, 0)
    assert.deepEqual(JSON.parse(env.ctx.localStorage.getItem(SNAP)).itens.map((t) => t.id), [2])
  })
}

test('Concluir: envelope completo e igual ao card (tarefa, aberta, dono, lead) → conclui', () => {
  const env = ambiente()
  let patches = 0
  kommo(env, (o) => {
    if (o.method === 'PATCH') { patches++; return { status: 200, body: {} } }
    if (o.method === 'GET' && /\/api\/v4\/tasks\/1$/.test(o.url)) return { status: 200, body: { ...viva(1), entity_type: 'leads', entity_id: 10 } }
    return { status: 0 }
  })
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), tarefa(2)] }])
  w.callbacks.init(); env.rodarTimers('t')
  clicar(env, 'avancar'); clicar(env, 'concluir')
  assert.equal(patches, 1)
})

test('retry pendente → destroy → init → novo em_andamento: agenda o retry de 7 s de novo', () => {
  const env = ambiente()
  const w = instanciar(env, [])
  w.$authorizedAjax = () => ({ then: (ok, err) => err({ status: 503, responseJSON: { erro: 'em_andamento', retry_after: 3 } }) })
  w.callbacks.init(); env.rodarTimers('t')
  assert.ok([...env.timers.values()].some((t) => !t.i && t.ms === 7000))
  w.callbacks.destroy(); assert.equal(env.timers.size, 0)
  env.ctx.localStorage.setItem('rpv_pausa_financeirorustonengenhariacombr_11420911', '0')
  w.callbacks.init(); env.rodarTimers('t')
  assert.ok([...env.timers.values()].some((t) => !t.i && t.ms === 7000))
})

test('0.4.8: ligação 4com termina → o widget pede o RESULTADO (CDR) e mostra no rodapé; pendente tenta de novo', async () => {
  const env = ambiente(), reg = {}
  let perfT = 1000; env.ctx.performance = { now: () => perfT }
  let n = 0
  const { w, chamadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [] },
    discar: { ok: true, provedor: '4com', chamada_id: 'm1', ev: 77 },
    resultado: (b) => (++n === 1 ? { ok: true, resultados: [], pedido: { ev: b.ev, pendente: true } }
                                 : { ok: true, resultados: [], pedido: { ev: b.ev, rotulo: 'não atendida', duracao: 0, nota: true } }),
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  const digitar = env.ouvintes.find((o) => o[0] === 'input')[1]
  digitar({ target: { id: 'rpv-manual', value: '47 99729-3673' } }); clicar(env, 'voz-manual')
  assert.ok(chamadas.some((c) => c.acao === 'discar'))
  const inv = sessao(true); reg.emit('newRTCSession', inv); inv.session.terminate()          // a chamada acaba
  const t8 = [...env.timers.values()].find((t) => !t.i && t.ms === 8000); assert.ok(t8, 'agendou a consulta pós-chamada')
  t8.fn()
  assert.deepEqual(chamadas.filter((c) => c.acao === 'resultado').map((c) => c.ev), [77])   // 1ª: ainda pendente
  const t20 = [...env.timers.values()].find((t) => !t.i && t.ms === 20000); assert.ok(t20, 'tentará de novo'); t20.fn()
  assert.equal(chamadas.filter((c) => c.acao === 'resultado').length, 2)
  assert.match(env.elems['rpv-root'].innerHTML, /Última ligação: não atendida \(registrada no Kommo\)/)
})

test('0.4.8: resultado de uma ligação ANTIGA não sobrescreve o da nova (a cadeia mais nova vence)', async () => {
  const env = ambiente(), reg = {}
  let perfT = 1000; env.ctx.performance = { now: () => perfT }
  let ev = 70
  const { w, chamadas } = comVoz(env, reg, {
    credencial: CRED, telefones: { ok: true, contatos: [] },
    discar: () => ({ ok: true, provedor: '4com', chamada_id: 'x', ev: ++ev }),
    resultado: (b) => ({ ok: true, resultados: [], pedido: { ev: b.ev, rotulo: b.ev === 71 ? 'ocupado' : 'atendida', duracao: 12, nota: true } }),
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  const digitar = env.ouvintes.find((o) => o[0] === 'input')[1]
  digitar({ target: { id: 'rpv-manual', value: '47 99729-3673' } }); clicar(env, 'voz-manual')       // ev 71
  const velho = [...env.timers.values()].find((t) => !t.i && t.ms === 90000)
  perfT += 1500; clicar(env, 'voz-manual')                                                          // ev 72 substitui
  velho.fn()                                                                                          // a consulta da 71 dispara depois
  assert.equal(chamadas.filter((c) => c.acao === 'resultado').length, 0)                             // descartada (cadeia velha)
  const novo = [...env.timers.values()].filter((t) => !t.i && t.ms === 90000).pop(); novo.fn()
  assert.match(env.elems['rpv-root'].innerHTML, /Última ligação: atendida · 00:12/)
})

test("resultado da ligação: as consultas do widget vão além dos 15 min do 'sem registro' (o cron cobre aba fechada)", () => {
  const m = SRC.match(/if \(\+\+voz\.resTent < (\d+)\) agendarResultado\(g, ev, \[([\d, ]+)\]/)
  assert.ok(m)
  const esperas = m[2].split(',').map(Number), n = Number(m[1])
  assert.equal(esperas.length, n - 1)
  const aposFim = 8000 + esperas.reduce((a, b) => a + b, 0), aposDiscar = 90000 + esperas.reduce((a, b) => a + b, 0)
  assert.ok(aposFim > 15 * 60_000 && aposDiscar > 15 * 60_000)
})

// ======================================================================
// 0.5.3 — pílula-toggle (Ligar · Notificações · fila), padrão fechado, estado e posição por usuário
// ======================================================================
const POS_KEY = 'rpv_pos_financeirorustonengenhariacombr_11420911'
const ouvinte = (env, ev) => env.ouvintes.find((o) => o[0] === ev && !o[2])[1]

test('pílula-toggle: padrão FECHADO; "Ligar" abre e fecha o telefone e o estado fica salvo', async () => {
  const env = ambiente(), reg = {}
  const { w } = comVoz(env, reg, { credencial: CRED }, { __fechado: true })
  w.callbacks.init(); await flush(); reg.emit('registered')
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /^<div class="rpv-tog/)                                   // topo: a pílula vem primeiro
  assert.match(html, /data-act="voz" aria-pressed="false"/)
  assert.match(html, /rpv-tb-voz st-ok/)                                       // ponto verde: ramal registrado
  assert.doesNotMatch(html, /Telefone/)                                        // painel do telefone escondido
  clicar(env, 'voz')
  html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Telefone 4com · pronto/); assert.match(html, /data-act="voz" aria-pressed="true"/)
  assert.deepEqual(JSON.parse(env.ctx.localStorage.getItem(UI_KEY)), { voz: true, fila: false })
  clicar(env, 'voz')
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /Telefone/)
  assert.deepEqual(JSON.parse(env.ctx.localStorage.getItem(UI_KEY)), { voz: false, fila: false })
})

test('pílula-toggle: chamada recebida abre o telefone sozinha mesmo com o toggle fechado; fica 20 s após o fim e esconde', async () => {
  const env = ambiente(), reg = {}
  const { w } = comVoz(env, reg, { credencial: CRED }, { __fechado: true })
  w.callbacks.init(); await flush(); reg.emit('registered')
  const s = sessao(false); reg.emit('newRTCSession', s)
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Chamada recebida/); assert.match(html, /rpv-tb-voz st-tocando/)
  s.session.terminate(); env.rodarTimers('i')
  html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Telefone 4com/)                                          // janela pós-ligação: resultado visível
  assert.doesNotMatch(html, /Chamada recebida/); assert.match(html, /data-act="voz" aria-pressed="false"/)
  const agoraReal = Date.now
  env.ctx.Date = class extends Date { static now() { return agoraReal() + 21000 } }
  env.rodarTimers('i')
  assert.doesNotMatch(env.elems['rpv-root'].innerHTML, /Telefone 4com/)
})

test('pílula-toggle: title do Ligar traz o estado do ramal; "outra aba" fica amarelo', async () => {
  const env = ambiente(), reg = {}
  const { w } = comVoz(env, reg, { credencial: CRED }, { __fechado: true })
  w.callbacks.init(); await flush(); reg.emit('registered')
  assert.match(env.elems['rpv-root'].innerHTML, /title="Ramal: pronto · clique para abrir"/)
})

test('pílula-toggle: posição salva em tela maior é trazida para dentro da tela atual; arrasto cancela ao sair da janela', () => {
  const env = ambiente()
  env.ctx.window.innerWidth = 1366; env.ctx.window.innerHeight = 700
  env.ctx.localStorage.setItem(POS_KEY, JSON.stringify({ top: 950, lado: 1700 }))
  const w = instanciar(env, [{ ok: true, itens: [] }])
  w.callbacks.init(); env.rodarTimers('t')
  const root = env.elems['rpv-root']
  assert.equal(root.style.top, '660px'); assert.equal(root.style.right, '1246px')
  root.getBoundingClientRect = () => ({ top: 660, right: 120, left: 0, bottom: 690 })
  const alca = { closest: (sel) => (sel === '[data-drag]' ? {} : null) }
  ouvinte(env, 'mousedown')({ target: alca, button: 0, clientX: 50, clientY: 670, preventDefault() {} })
  ouvinte(env, 'mouseleave')({})
  ouvinte(env, 'mousemove')({ clientX: 400, clientY: 100 })                       // voltou sem botão: não arrasta mais
  assert.equal(root.style.top, '660px')
})

test('pílula-toggle: estado salvo (telefone e fila abertos) é restaurado no próximo carregamento', async () => {
  const env = ambiente(), reg = {}
  env.ctx.localStorage.setItem(UI_KEY, JSON.stringify({ voz: true, fila: true }))
  const { w } = comVoz(env, reg, { credencial: CRED }, { __fechado: true })
  w.callbacks.init(); await flush(); reg.emit('registered')
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Telefone 4com · pronto/); assert.match(html, /Sua fila · /)
})

test('pílula-toggle: sininho = Próximo (contador, vermelho com atraso, clique avança); seta abre a fila; Alt+N mantido', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), tarefa(2)], frescor: { atraso_s: 30, status: 'done' } }])
  w.callbacks.init(); env.rodarTimers('t')
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /rpv-tb-ntf late" data-act="avancar" title="Próximo: Lead 1/)
  assert.match(html, /🔔<span class="cnt">2<\/span>/)
  assert.doesNotMatch(html, /data-act="voz"/)                                 // sem voz=Y: sem botão Ligar
  assert.doesNotMatch(html, /Sua fila/)
  clicar(env, 'painel'); assert.match(env.elems['rpv-root'].innerHTML, /Sua fila · 2/)
  assert.deepEqual(JSON.parse(env.ctx.localStorage.getItem(UI_KEY)), { voz: false, fila: true })
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')
  ouvinte(env, 'keydown')({ altKey: true, key: 'n', target: { tagName: 'DIV' }, preventDefault() {} })
  assert.equal(env.ctx.location.pathname, '/leads/detail/20')
})

test('pílula-toggle: posição padrão abaixo do cabeçalho, à esquerda da coluna Widgets; arrastar salva; duplo clique volta', () => {
  const env = ambiente()
  env.ctx.window.innerWidth = 1900; env.ctx.window.innerHeight = 1000
  const w = instanciar(env, [{ ok: true, itens: [] }])
  w.callbacks.init(); env.rodarTimers('t')
  const root = env.elems['rpv-root']
  assert.equal(root.style.top, '70px'); assert.equal(root.style.right, '72px'); assert.equal(root.style.bottom, '')
  root.getBoundingClientRect = () => ({ top: 70, right: 1900 - 72, left: 1700, bottom: 100 })
  const alca = { closest: (sel) => (sel === '[data-drag]' ? {} : null) }
  ouvinte(env, 'mousedown')({ target: alca, button: 0, clientX: 1750, clientY: 70, preventDefault() {} })
  ouvinte(env, 'mousemove')({ clientX: 1650, clientY: 300 })
  ouvinte(env, 'mouseup')({})
  assert.equal(root.style.top, '300px'); assert.equal(root.style.right, '172px')
  assert.deepEqual(JSON.parse(env.ctx.localStorage.getItem(POS_KEY)), { top: 300, lado: 172 })
  ouvinte(env, 'dblclick')({ target: alca })
  assert.equal(root.style.top, '70px'); assert.equal(root.style.right, '72px')
  assert.equal(JSON.parse(env.ctx.localStorage.getItem(POS_KEY)), null)
})

test('pílula-toggle: clique curto na alça não move; position=bottom-right mantém a pílula embaixo (por último)', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)] }], { position: 'bottom-right', offset: '96' })
  w.callbacks.init(); env.rodarTimers('t')
  const root = env.elems['rpv-root']
  assert.equal(root.style.bottom, '96px'); assert.equal(root.style.top, '')
  root.getBoundingClientRect = () => ({ top: 900, right: 1828, left: 1700, bottom: 930 })
  const alca = { closest: (sel) => (sel === '[data-drag]' ? {} : null) }
  ouvinte(env, 'mousedown')({ target: alca, button: 0, clientX: 10, clientY: 10, preventDefault() {} })
  ouvinte(env, 'mousemove')({ clientX: 11, clientY: 11 }); ouvinte(env, 'mouseup')({})
  assert.equal(env.ctx.localStorage.getItem(POS_KEY), null); assert.equal(root.style.bottom, '96px')
  clicar(env, 'painel')
  assert.match(root.innerHTML, /Sua fila[\s\S]*<div class="rpv-tog/)              // base: a fila abre em cima da pílula
})
