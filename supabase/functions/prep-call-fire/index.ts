// =============================================================
// Edge Function: prep-call-fire
// =============================================================
// Proxy server-side pra chamar a Claude Code Routine /fire.
// O browser NAO pode chamar api.anthropic.com diretamente (CORS +
// exposicao do token). Essa function recebe o briefing_id + inputs,
// busca token/routine_id de integracao_config e dispara a Routine.
//
// Input (POST JSON):
//   {
//     "briefing_id": "<uuid>",
//     "empresa": "<string>",
//     "inputs": { site, instagram, segmento, ... }
//   }
//
// Output:
//   { session_id, session_url }
// =============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/claude_code/routines'
const ANTHROPIC_BETA = 'experimental-cc-routine-2026-04-01'
const ANTHROPIC_VERSION = '2023-06-01'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function getSupabaseAdmin() {
    return createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders })
    }
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }

    try {
        const supabase = getSupabaseAdmin()
        const body = await req.json()
        const briefingId = body.briefing_id as string
        const empresa = body.empresa as string
        const inputs = (body.inputs || {}) as Record<string, string>

        if (!briefingId || !empresa) {
            return new Response(JSON.stringify({ error: 'missing briefing_id or empresa' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Auth indireta: o briefing tem que existir (criado por user autenticado via RLS).
        // Sem verify_jwt no gateway, essa checagem bloqueia abuso anonimo.
        const { data: brief, error: briefErr } = await supabase
            .from('prep_briefings')
            .select('id, status')
            .eq('id', briefingId)
            .maybeSingle()

        if (briefErr || !brief) {
            return new Response(JSON.stringify({ error: 'briefing nao encontrado' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }
        if (brief.status === 'completed' || brief.status === 'processing') {
            return new Response(JSON.stringify({ error: `briefing ja esta em ${brief.status}` }), {
                status: 409,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Carrega config do banco
        const { data: cfg, error: cfgErr } = await supabase
            .from('integracao_config')
            .select('key, value')
            .in('key', ['claude_code_routine_token', 'claude_code_routine_id'])

        if (cfgErr) {
            return new Response(JSON.stringify({ error: `config error: ${cfgErr.message}` }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const configMap: Record<string, string> = {}
        for (const row of cfg || []) configMap[row.key] = row.value

        const token = configMap.claude_code_routine_token
        const routineId = configMap.claude_code_routine_id

        if (!token || !routineId) {
            return new Response(JSON.stringify({
                error: 'Routine nao configurada no banco (token ou routine_id vazio em integracao_config)',
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Payload pra Routine (todos os campos; briefing_id ecoado no callback)
        const payload = {
            briefing_id: briefingId,
            empresa,
            segmento: inputs.segmento || '',
            site: inputs.site || '',
            instagram: inputs.instagram || '',
            faturamento_atual: inputs.faturamento_atual || '',
            meta_faturamento: inputs.meta_faturamento || '',
            concorrentes_conhecidos: inputs.concorrentes_conhecidos || '',
            contexto: inputs.contexto || '',
            // V2: bibliotecas de ads (opcionais — Routine checa se vieram preenchidas)
            meta_ads_library_url: inputs.meta_ads_library_url || '',
            google_ads_transparency_url: inputs.google_ads_transparency_url || '',
        }

        const resp = await fetch(`${ANTHROPIC_API}/${routineId}/fire`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'anthropic-beta': ANTHROPIC_BETA,
                'anthropic-version': ANTHROPIC_VERSION,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: JSON.stringify(payload) }),
        })

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '')
            return new Response(JSON.stringify({
                error: `Routine /fire ${resp.status}: ${errText.slice(0, 300)}`,
            }), {
                status: resp.status === 401 || resp.status === 403 ? resp.status : 502,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const data = await resp.json()
        return new Response(JSON.stringify({
            session_id: data.claude_code_session_id || data.session_id || '',
            session_url: data.claude_code_session_url || data.session_url || '',
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    } catch (e: any) {
        console.error('prep-call-fire error:', e)
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }
})
