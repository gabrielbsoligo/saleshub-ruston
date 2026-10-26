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
  const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap_financeirorustonengenhariacombr_11420911'))
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
  assert.equal(env.ctx.localStorage.getItem('rpv_lider_financeirorustonengenhariacombr_11420911'), 'null')
  w.callbacks.init(); env.rodarTimers()
  assert.ok(env.elems['rpv-root']); assert.equal(env.ouvintes.filter((o) => o[0] === 'keydown').length, 1)
})

test('segunda aba não consulta enquanto a líder estiver ativa (usa o snapshot)', () => {
  const env = ambiente()
  const a = instanciar(env, [{ ok: true, itens: [tarefa(1)], frescor: { atraso_s: 1, status: 'done' } }])
  a.callbacks.init(); env.rodarTimers()
  // simula outra aba: lock de outra aba ainda válido
  env.ctx.localStorage.setItem('rpv_lider_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 60000 }))
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
const SNAP = 'rpv_snap_financeirorustonengenhariacombr_11420911'
const viva = (id) => ({ id, is_completed: false, responsible_user_id: 11420911, complete_till: AGORA - 60, text: 't' + id })

test('concluir: a réplica atrasada (ainda com a tarefa aberta) não a ressuscita no ciclo seguinte', () => {
  const env = ambiente()
  kommo(env, (o) => {
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

test('com falha registrada, ações ficam suspensas (botão Próximo desabilitado, Concluir não envia)', () => {
  const env = ambiente()
  let patches = 0
  kommo(env, (o) => { if (o.method === 'PATCH') { patches++; return { status: 200, body: {} } } return { status: 0 } })
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1)], frescor: { atraso_s: 1, status: 'done' } },
    { erro: 'falha_banco', status: 503 },
  ])
  w.callbacks.init(); env.rodarTimers('t'); env.rodarTimers('i')       // 2º ciclo falha (servidor + Kommo)
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /rpv-pill off/); assert.doesNotMatch(html, /data-act=avancar/)
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'concluir' }) } })
  assert.equal(patches, 0)
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

test('P1: resposta com dados de 24h (cache em andamento) não rejuvenesce: ações e avisos suspensos', () => {
  const env = ambiente()
  const velho = AGORA - 86400
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)], em_andamento: true, gerado_em: velho }])
  w.callbacks.init(); env.rodarTimers('t')
  const snap = JSON.parse(env.ctx.localStorage.getItem(SNAP))
  assert.equal(snap.dadosEm, velho)                                   // idade real preservada
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /rpv-pill off/); assert.doesNotMatch(html, /data-act="avancar"/)
  assert.doesNotMatch(html, /rpv-ntf/)                                // sem notificação sobre dado vencido
})

test('P1: depois de uma falha, um cache velho não limpa a falha nem habilita ações', () => {
  const env = ambiente()
  const w = instanciar(env, [
    { ok: true, itens: [tarefa(1)], gerado_em: AGORA },
    { erro: 'falha_banco', status: 503 },
    { ok: true, itens: [tarefa(1)], em_andamento: true, gerado_em: AGORA - 86400 },
  ])
  w.callbacks.init(); env.rodarTimers('t'); env.rodarTimers('i'); env.rodarTimers('i')
  const html = env.elems['rpv-root'].innerHTML
  assert.match(html, /rpv-pill off/)
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
test('após falha: cache ANTERIOR (−30 s, ainda dentro de 3 ciclos) é ignorado — falha, dadosEm, ids e ações preservados', () => {
  const { env, snap } = cenarioFalha({ ok: true, itens: [tarefa(9)], em_andamento: true, gerado_em: AGORA - 30 })
  assert.ok(snap.falha); assert.equal(snap.dadosEm, AGORA); assert.deepEqual(snap.itens.map((t) => t.id), [1, 2])
  assert.match(env.elems['rpv-root'].innerHTML, /rpv-pill off/)
})
test('após falha: cache com o MESMO gerado_em também é ignorado', () => {
  const { env, snap } = cenarioFalha({ ok: true, itens: [tarefa(9)], em_andamento: true, gerado_em: AGORA })
  assert.ok(snap.falha); assert.equal(snap.dadosEm, AGORA); assert.deepEqual(snap.itens.map((t) => t.id), [1, 2])
  assert.match(env.elems['rpv-root'].innerHTML, /rpv-pill off/)
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
  assert.match(env.elems['rpv-root'].innerHTML, /Telefone · pronto/)
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

test('discar: lista telefones, pede à 4com e NUNCA atende sozinho (nem a integrada pedida, nem uma qualquer)', async () => {
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
  // INVITE integrado enquanto o pedido está pendente: só toca, com o rótulo "sua ligação"
  const integrada = sessao(true); reg.emit('newRTCSession', integrada)
  assert.equal(integrada.session.atendida, undefined)
  assert.match(env.elems['rpv-root'].innerHTML, /Sua ligação: atenda/)
  clicar(env, 'voz-atender')                                   // o usuário atende
  assert.equal(integrada.session.atendida, true); assert.match(env.elems['rpv-root'].innerHTML, /Em chamada/)
  integrada.session.terminate()
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

test('chat com leitura velha (chats_em > 2 min ou ausente) não aparece nem notifica; as tarefas ficam', () => {
  const env = ambiente()
  const agora = Math.floor(Date.now() / 1000)
  const chat = { id: -9, entity_type: 'leads', entity_id: 9, due: agora - 60, momento: 'chat_sem_resposta', grupo: 'G9', urgente: true, texto: 'c', acao: 'chat' }
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), chat], chats_em: agora - 200 }])
  w.callbacks.init(); env.rodarTimers('t')
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /<span class="cnt">1<\/span>/)                 // só a tarefa
  // aba seguidora com snapshot em que o chat ERA válido, mas envelheceu
  const B = ambiente()
  const snap = { itens: [tarefa(1), chat], modo: 'servidor', dadosEm: agora - 5, chatsEm: agora - 130, rev: 'r1' }
  B.ctx.localStorage.setItem('rpv_snap_financeirorustonengenhariacombr_11420911', JSON.stringify(snap))
  B.ctx.localStorage.setItem('rpv_lider_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 60000 }))
  const wb = instanciar(B, [{ ok: true, itens: [] }]); wb.callbacks.init()
  assert.match(B.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

test('INVITE chega ANTES da recusa do servidor: a recusa tira o rótulo "Sua ligação"', async () => {
  const env = ambiente(), reg = {}
  const { w, adiadas } = comVoz(env, reg, {
    credencial: CRED,
    telefones: { ok: true, contatos: [{ contato_id: 1, nome: 'Ana', telefones: [{ e164: '+5547997293673', exibir: 'x' }] }] },
    discar: 'adiar',
  })
  w.callbacks.init(); await flush(); reg.emit('registered')
  env.ctx.location.pathname = '/leads/detail/555'; env.rodarTimers('i')
  clicar(env, 'voz-ligar', { 'data-tel': '+5547997293673' })
  const inv = sessao(true); reg.emit('newRTCSession', inv)
  assert.match(env.elems['rpv-root'].innerHTML, /Sua ligação: atenda/)
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
    { ok: true, itens: [tarefa(1), chatItem(agora)], chats_em: agora - 119, gerado_em: g },
    { ok: true, itens: [tarefa(1)], chats_em: null, gerado_em: g },            // servidor já podou, mesmo gerado_em
  ])
  w.callbacks.init(); env.rodarTimers('t')
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">2<\/span>/)
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/555')   // ainda válido: abre o chat
  assert.match(env.elems['rpv-root'].innerHTML, /Responda o cliente no chat/)
  rel.avancar(6000); env.rodarTimers('i')                                   // 125 s: venceu; leitura com mesmo gerado_em é ignorada
  const html = env.elems['rpv-root'].innerHTML
  assert.doesNotMatch(html, /Responda o cliente no chat/); assert.match(html, /<span class="cnt">1<\/span>/)
  env.ctx.location.pathname = '/leads/pipeline'
  clicar(env, 'avancar'); assert.equal(env.ctx.location.pathname, '/leads/detail/10')    // vai para a tarefa, não para o chat
})

test('chat que envelhece em aba SEGUIDORA (snapshot sem rev nova): sai pelo relógio', () => {
  const B = ambiente(), rel = relogio(B)
  const agora = Math.floor(Date.now() / 1000)
  B.ctx.localStorage.setItem('rpv_snap_financeirorustonengenhariacombr_11420911', JSON.stringify({ itens: [tarefa(1), chatItem(agora)], modo: 'servidor', dadosEm: agora - 1, chatsEm: agora - 119, rev: 'r1' }))
  B.ctx.localStorage.setItem('rpv_lider_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 3600000 }))
  const w = instanciar(B, [{ ok: true, itens: [] }]); w.callbacks.init()
  assert.match(B.elems['rpv-root'].innerHTML, /<span class="cnt">2<\/span>/)
  rel.avancar(6000); B.rodarTimers('i')
  assert.match(B.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

test('chat que envelhece DURANTE pausa do Kommo: sai pelo relógio, tarefas e dados ficam', () => {
  const env = ambiente(), rel = relogio(env)
  const agora = Math.floor(Date.now() / 1000)
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1), chatItem(agora)], chats_em: agora - 119, retry_after: 300 }])
  w.callbacks.init(); env.rodarTimers('t')
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">2<\/span>/)
  let leu = false; w.$authorizedAjax = () => { leu = true; return { then() {} } }
  rel.avancar(6000); env.rodarTimers('i')
  assert.equal(leu, false)                                                   // pausado: não lê
  assert.match(env.elems['rpv-root'].innerHTML, /<span class="cnt">1<\/span>/)
})

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
  const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap_financeirorustonengenhariacombr_11420911'))
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
