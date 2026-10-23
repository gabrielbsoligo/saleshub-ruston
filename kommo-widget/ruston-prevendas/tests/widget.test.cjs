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
    { ok: true, tarefas: [tarefa(1), tarefa(2, { momento: 'anti_noshow', grupo: 'G9' })], frescor: { atraso_s: 30, status: 'done' } },
    { ok: true, tarefas: [tarefa(1)], frescor: { atraso_s: 30, status: 'done' } },
  ])
  w.callbacks.init()
  env.rodarTimers('t')                                // jitter inicial → 1º ciclo
  let html = env.elems['rpv-root'].innerHTML
  assert.match(html, /Próximo/); assert.match(html, /<span class="cnt">2<\/span>/)
  env.rodarTimers('i')                                // 2º ciclo: tarefa 2 saiu
  html = env.elems['rpv-root'].innerHTML
  assert.match(html, /<span class="cnt">1<\/span>/)
  const snap = JSON.parse(env.ctx.localStorage.getItem('rpv_snap_financeirorustonengenhariacombr_11420911'))
  assert.deepEqual(snap.tarefas.map((t) => t.id), [1])
})

test('servidor e Kommo falham: mantém a lista anterior com aviso de desatualizada (não finge "ok")', () => {
  const env = ambiente()
  const w = instanciar(env, [
    { ok: true, tarefas: [tarefa(1)], frescor: { atraso_s: 30, status: 'done' } },
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
  const w = instanciar(env, [{ ok: true, tarefas: [tarefa(1)] }], { usuarios: '999' })
  let chamou = false; w.$authorizedAjax = () => { chamou = true; return { then() {} } }
  w.callbacks.init(); env.rodarTimers()
  assert.equal(chamou, false); assert.equal(env.elems['rpv-root'], undefined); assert.equal(env.timers.size, 0)
})

test('init → destroy → init: sem timers, ouvintes ou raiz órfãos; lock liberado', () => {
  const env = ambiente()
  const w = instanciar(env, [{ ok: true, tarefas: [tarefa(1)], frescor: { atraso_s: 1, status: 'done' } }])
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
  const a = instanciar(env, [{ ok: true, tarefas: [tarefa(1)], frescor: { atraso_s: 1, status: 'done' } }])
  a.callbacks.init(); env.rodarTimers()
  // simula outra aba: lock de outra aba ainda válido
  env.ctx.localStorage.setItem('rpv_lider_financeirorustonengenhariacombr_11420911', JSON.stringify({ aba: 'outra', ate: Date.now() + 60000 }))
  let chamadas = 0
  a.$authorizedAjax = () => { chamadas++; return { then() {} } }
  env.rodarTimers()
  assert.equal(chamadas, 0)
})
