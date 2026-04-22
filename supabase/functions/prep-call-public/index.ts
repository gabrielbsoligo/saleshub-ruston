// =============================================================
// Edge Function: prep-call-public
// =============================================================
// Rota publica que entrega o briefing_json SEM os campos
// closer-only (analise_competitiva, pergunta_impacto,
// resumo_falado, alertas).
//
// Request: GET /functions/v1/prep-call-public?id=<uuid>
// Sem autenticacao. Seguranca: UUID (Q8=A).
// =============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function getSupabaseAdmin() {
    return createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )
}

// Remove campos sensiveis do JSON antes de enviar pro cliente.
function stripCloserOnly(json: any): any {
    if (!json || typeof json !== 'object') return json
    const { analise_competitiva, pergunta_impacto, resumo_falado, alertas, ...rest } = json
    return rest
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders })
    }

    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }

    try {
        const url = new URL(req.url)
        const id = url.searchParams.get('id')

        if (!id) {
            return new Response(JSON.stringify({ error: 'missing id' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const supabase = getSupabaseAdmin()
        const { data: briefing, error } = await supabase
            .from('prep_briefings')
            .select('id, empresa, briefing_json, schema_version, status, version, completed_at')
            .eq('id', id)
            .maybeSingle()

        if (error || !briefing) {
            return new Response(JSON.stringify({ error: 'briefing not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        if (briefing.status !== 'completed') {
            return new Response(JSON.stringify({ error: 'briefing not completed', status: briefing.status }), {
                status: 409,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        if (!briefing.briefing_json) {
            return new Response(JSON.stringify({ error: 'briefing legacy (no json available)', legacy: true }), {
                status: 409,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const clientSafe = stripCloserOnly(briefing.briefing_json)

        return new Response(
            JSON.stringify({
                id: briefing.id,
                empresa: briefing.empresa,
                schema_version: briefing.schema_version,
                version: briefing.version,
                completed_at: briefing.completed_at,
                briefing: clientSafe,
            }),
            {
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=60',
                },
            }
        )
    } catch (e: any) {
        console.error('prep-call-public error:', e)
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }
})
