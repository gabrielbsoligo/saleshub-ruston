// =============================================================
// Edge Function: prep-call-view-track
// =============================================================
// Rota publica chamada pela pagina /briefing/:id/apresentar
// para registrar abertura do briefing pelo cliente.
//
// Q15 = A: 1 view por sessao em janela de 30min.
// Debounce via session_token + ip_hash + janela temporal.
//
// Request:
//   POST /functions/v1/prep-call-view-track
//   Body: { briefing_id: string, session_token: string, referrer?: string }
//
// Sem autenticacao — e' a pagina publica.
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

async function sha256(input: string): Promise<string> {
    const buf = new TextEncoder().encode(input)
    const hash = await crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
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
        const briefingId: string | undefined = body.briefing_id
        const sessionToken: string | undefined = body.session_token
        const referrer: string | undefined = body.referrer

        if (!briefingId || !sessionToken) {
            return new Response(JSON.stringify({ error: 'missing briefing_id or session_token' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Confirma que o briefing existe (previne spam de IDs invalidos)
        const { data: briefing } = await supabase
            .from('prep_briefings')
            .select('id')
            .eq('id', briefingId)
            .maybeSingle()

        if (!briefing) {
            return new Response(JSON.stringify({ error: 'briefing not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Debounce Q15=A: se ja existe view com mesmo session_token
        // nos ultimos 30min, nao registra de novo (evita contar F5).
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
        const { data: recent } = await supabase
            .from('prep_briefing_views')
            .select('id, viewed_at')
            .eq('briefing_id', briefingId)
            .eq('session_token', sessionToken)
            .gte('viewed_at', thirtyMinAgo)
            .limit(1)
            .maybeSingle()

        if (recent) {
            return new Response(JSON.stringify({ ok: true, debounced: true }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Hash do IP (nao guardar IP direto por LGPD)
        const xff = req.headers.get('x-forwarded-for') || ''
        const ip = xff.split(',')[0]?.trim() || req.headers.get('cf-connecting-ip') || 'unknown'
        const ipHash = await sha256(ip + briefingId) // salt com briefing_id

        const userAgent = req.headers.get('user-agent') || null

        const { error: insErr } = await supabase
            .from('prep_briefing_views')
            .insert({
                briefing_id: briefingId,
                session_token: sessionToken,
                ip_hash: ipHash,
                user_agent: userAgent,
                referrer: referrer || null,
            })

        if (insErr) {
            console.error('prep-call-view-track insert error:', insErr)
            return new Response(JSON.stringify({ error: insErr.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        return new Response(JSON.stringify({ ok: true, tracked: true }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    } catch (e: any) {
        console.error('prep-call-view-track error:', e)
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }
})
