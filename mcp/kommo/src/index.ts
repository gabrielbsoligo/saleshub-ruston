// Servidor MCP (Fase 1) — leitura sobre a réplica `kommo` no mesmo Postgres do SalesHub.
// Não toca a API do Kommo: tudo sai do Postgres (rápido, sem rate limit).
//
// Config (env):
//   DATABASE_URL  -> string de conexão Postgres do projeto Supabase (read-only de preferência)
//
// Tools:
//   find_stale_deals(valor_min, dias, somente_com_vinculo) -> deals com proposta parados há N dias
//   list_recipes() -> descreve as recipes disponíveis
//
// Transporte stdio (uso individual no Claude Code). HTTP autenticado vem na Fase 8.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

const server = new McpServer({ name: 'kommo-saleshub-mcp', version: '0.1.0' })

server.tool(
  'find_stale_deals',
  'Lista deals do SalesHub COM proposta (produto + preço) que estão parados há >= `dias`, ' +
    'cruzando com a última atividade real no Kommo (tarefa, nota, mensagem de chat/WhatsApp ' +
    'ou mudança de etapa). O corte de valor/dias é parâmetro — a view entrega last_activity_at cru.',
  {
    valor_min: z.number().default(50000).describe('Valor mínimo do deal (valor_ot + valor_mrr). Default 50000.'),
    dias: z.number().int().default(15).describe('Dias sem atividade para considerar parado. Default 15.'),
    somente_com_vinculo: z.boolean().default(true)
      .describe('Se true, só deals com kommo_id resolvido (atividade verificável no Kommo).'),
  },
  async ({ valor_min, dias, somente_com_vinculo }) => {
    const { rows } = await pool.query(
      'select * from kommo.find_stale_deals($1, $2, $3)',
      [valor_min, dias, somente_com_vinculo],
    )
    const total = rows.reduce((s, r) => s + Number(r.valor_total || 0), 0)
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: rows.length, valor_total_somado: total, deals: rows }, null, 2),
      }],
    }
  },
)

server.tool(
  'list_recipes',
  'Lista as recipes/ferramentas de leitura disponíveis nesta réplica Kommo↔SalesHub.',
  {},
  async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        recipes: [{
          name: 'find_stale_deals',
          desc: 'Deals com proposta parados há N dias (atividade via Kommo: task/nota/chat/etapa).',
          params: { valor_min: 'number=50000', dias: 'int=15', somente_com_vinculo: 'bool=true' },
        }],
      }, null, 2),
    }],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('kommo-saleshub-mcp rodando (stdio).')
