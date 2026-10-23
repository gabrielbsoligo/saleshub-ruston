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
    const r = respostas[Math.min(n++, respostas.length - 1)]
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

test('só o que o servidor emitiu aparece; pendentes viram contagem', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, itens: [tarefa(1)], futura: tarefa(5, { due: AGORA + 3600 }), pendentes: 7, frescor: { atraso_s: 1, status: 'done' } }])
  w.callbacks.init(); env.rodarTimers('t')
  const clique = env.ouvintes.find((o) => o[0] === 'click' && !o[2])[1]
  clique({ target: { closest: () => ({ getAttribute: () => 'painel' }) } })
  const html = env.elems['rpv-root'].innerHTML
  assert.ok(html.includes('Sua fila · 1 (+7)'))
  assert.ok(html.includes('+7 tarefas ainda não conferidas'))
})
