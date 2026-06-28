# kommo-saleshub-mcp (Fase 1)

Servidor MCP de **leitura** sobre a réplica `kommo` no mesmo Postgres do SalesHub.
Não bate na API do Kommo — tudo sai do Postgres.

## Configurar
```bash
cd mcp/kommo
npm install
npm run build
```
Env: `DATABASE_URL` = string de conexão Postgres do projeto Supabase (de preferência um
role somente-leitura).

## Plugar no Claude Code (stdio)
```json
{
  "mcpServers": {
    "kommo-saleshub": {
      "command": "node",
      "args": ["mcp/kommo/dist/index.js"],
      "env": { "DATABASE_URL": "postgres://..." }
    }
  }
}
```

## Tools
- `find_stale_deals(valor_min=50000, dias=15, somente_com_vinculo=true)` — deals com proposta
  parados há N dias, com `last_activity_at` cruzado do Kommo (task/nota/chat/etapa).
- `list_recipes()` — descreve as recipes disponíveis.

Transporte HTTP autenticado (time/Routines) vem na Fase 8.
