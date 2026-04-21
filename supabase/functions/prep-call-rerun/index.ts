// =============================================================
// Edge Function: prep-call-rerun
// =============================================================
// Rerun da Routine usando scraped_data ja existente no banco.
//
// Caso de uso: briefing travou em 'analyzing' (Routine caiu com
// Stream idle, timeout, etc) mas scraping ja rodou. Em vez de
// re-disparar GitHub Action (2-3 min de scraping), chama Routine
// diretamente com dados que ja temos.
//
// Se o briefing NAO tiver scraped_data util, retorna 400 e o
// client cai pro prep-call-fire normal.
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (padrao)
//   CLAUDE_ROUTINE_TRIGGER_URL
//   CLAUDE_ROUTINE_API_KEY
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

function hasUsefulScrapedData(sd: any): boolean {
    if (!sd || typeof sd !== 'object') return false
    const site = sd.site?.fetched === true
    const ig = sd.instagram?.fetched === true
    const meta = sd.meta_ads?.fetched === true
    const google = sd.google_ads?.fetched === true
    return site || ig || meta || google
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

        if (!briefingId) {
            return new Response(JSON.stringify({ error: 'missing briefing_id' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const { data: brief, error: briefErr } = await supabase
            .from('prep_briefings')
            .select('id, empresa, inputs, scraped_data, status')
            .eq('id', briefingId)
            .maybeSingle()

        if (briefErr || !brief) {
            return new Response(JSON.stringify({ error: 'briefing nao encontrado' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        if (!hasUsefulScrapedData(brief.scraped_data)) {
            return new Response(JSON.stringify({
                error: 'sem scraped_data util — use prep-call-fire pra fluxo completo',
                should_fallback: true,
            }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const routineUrl = Deno.env.get('CLAUDE_ROUTINE_TRIGGER_URL') || ''
        const routineKey = Deno.env.get('CLAUDE_ROUTINE_API_KEY') || ''

        if (!routineUrl || !routineKey) {
            return new Response(JSON.stringify({
                error: 'Routine nao configurada (CLAUDE_ROUTINE_TRIGGER_URL / CLAUDE_ROUTINE_API_KEY)',
            }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const inputs = brief.inputs || {}
        const routinePayload = {
            briefing_id: briefingId,
            empresa: brief.empresa,
            segmento: inputs.segmento || '',
            site: inputs.site || '',
            instagram: inputs.instagram || '',
            faturamento_atual: inputs.faturamento_atual || '',
            meta_faturamento: inputs.meta_faturamento || '',
            concorrentes_conhecidos: inputs.concorrentes_conhecidos || '',
            contexto: inputs.contexto || '',
            meta_ads_library_url: inputs.meta_ads_library_url || '',
            google_ads_transparency_url: inputs.google_ads_transparency_url || '',
            scraped_data: brief.scraped_data,
        }

        // Marca como processing + analyzing (pulamos scraping)
        await supabase.from('prep_briefings').update({
            status: 'processing',
            progress_stage: 'calling_routine',
            failed_stage: null,
            error_message: null,
            briefing_markdown: null,
            completed_at: null,
        }).eq('id', briefingId)

        const resp = await fetch(routineUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${routineKey}`,
                'anthropic-beta': 'experimental-cc-routine-2026-04-01',
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: JSON.stringify(routinePayload),
            }),
        })

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '')
            await supabase.from('prep_briefings').update({
                status: 'error',
                failed_stage: 'routine_call',
                error_message: `Routine /fire ${resp.status}: ${errText.slice(0, 300)}`,
            }).eq('id', briefingId)
            return new Response(JSON.stringify({
                error: `Routine /fire falhou (${resp.status}): ${errText.slice(0, 300)}`,
            }), {
                status: 502,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const data = await resp.json()
        const sessionId = data.claude_code_session_id || data.session_id || ''
        const sessionUrl = data.claude_code_session_url || data.session_url || ''

        await supabase.from('prep_briefings').update({
            progress_stage: 'analyzing',
            routine_session_id: sessionId,
            routine_session_url: sessionUrl,
        }).eq('id', briefingId)

        return new Response(JSON.stringify({
            rerun: true,
            session_id: sessionId,
            session_url: sessionUrl,
            message: 'Rerun disparado usando scraped_data existente',
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    } catch (e: any) {
        console.error('prep-call-rerun error:', e)
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }
})
