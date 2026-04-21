// =============================================================
// Edge Function: prep-call-fire
// =============================================================
// Dispara um GitHub Action que vai coletar dados (scraping) e
// depois chamar a Claude Code Routine com o payload enriquecido.
//
// Antes (v1-v3): chamava a Routine direto.
// Agora (v4+): dispara repository_dispatch e deixa o worker (GitHub
// Actions) coletar dados + chamar a Routine com scraped_data incluso.
//
// Env vars necessarias:
//   GITHUB_REPO_DISPATCH_TOKEN — PAT com Actions: write pro repo
//   GITHUB_REPO_OWNER — ex: gabrielbsoligo
//   GITHUB_REPO_NAME — ex: saleshub-ruston
//
// Config no banco (integracao_config):
//   (nenhum — Routine eh chamada agora pelo worker com secrets do GitHub)
// =============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

        // Auth indireta: briefing precisa existir (criado por user autenticado via RLS).
        const { data: brief, error: briefErr } = await supabase
            .from('prep_briefings')
            .select('id, status, lead_id, empresa, created_at')
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

        // Idempotencia: se ja ha briefing processing pro mesmo lead/empresa nos ultimos 5min,
        // nao dispara outro — evita duplo click ou retry paralelo.
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
        const { data: recent } = await supabase
            .from('prep_briefings')
            .select('id')
            .eq('empresa', brief.empresa)
            .eq('status', 'processing')
            .gt('created_at', fiveMinAgo)
            .neq('id', briefingId)
            .limit(1)
            .maybeSingle()
        if (recent) {
            return new Response(JSON.stringify({
                error: 'Ja existe briefing em processamento pra essa empresa nos ultimos 5 min',
                existing_id: recent.id,
            }), {
                status: 409,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // GitHub dispatch
        const ghToken = Deno.env.get('GITHUB_REPO_DISPATCH_TOKEN')
        const ghOwner = Deno.env.get('GITHUB_REPO_OWNER')
        const ghRepo = Deno.env.get('GITHUB_REPO_NAME')

        if (!ghToken || !ghOwner || !ghRepo) {
            const missing = { GITHUB_REPO_DISPATCH_TOKEN: !!ghToken, GITHUB_REPO_OWNER: !!ghOwner, GITHUB_REPO_NAME: !!ghRepo }
            return new Response(JSON.stringify({
                error: 'GitHub config ausente nas env vars da edge function',
                detail: missing,
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const dispatchUrl = `https://api.github.com/repos/${ghOwner}/${ghRepo}/dispatches`
        const clientPayload = {
            briefing_id: briefingId,
            empresa,
            inputs,
        }

        const resp = await fetch(dispatchUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ghToken}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                event_type: 'prep-call-briefing',
                client_payload: clientPayload,
            }),
        })

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '')

            // Marca failed_stage no banco pra debug
            await supabase.from('prep_briefings').update({
                status: 'error',
                failed_stage: 'dispatch',
                error_message: `GitHub dispatch ${resp.status}: ${errText.slice(0, 300)}`,
            }).eq('id', briefingId)

            return new Response(JSON.stringify({
                error: `GitHub dispatch falhou (${resp.status}): ${errText.slice(0, 300)}`,
            }), {
                status: resp.status === 401 || resp.status === 403 ? resp.status : 502,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Marca como processing — worker atualiza depois
        await supabase.from('prep_briefings').update({
            status: 'processing',
        }).eq('id', briefingId)

        return new Response(JSON.stringify({
            dispatched: true,
            message: 'GitHub Action disparado. Worker vai processar e disparar a Routine.',
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
