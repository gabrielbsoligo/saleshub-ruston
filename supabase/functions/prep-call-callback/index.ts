// =============================================================
// Edge Function: prep-call-callback
// =============================================================
// Endpoint chamado pela Claude Code Routine quando termina de
// gerar o briefing pre-reuniao.
//
// Request:
//   POST /functions/v1/prep-call-callback
//   Headers:
//     X-Routine-Secret: <secret armazenado em integracao_config>
//     Content-Type: application/json
//   Body:
//     {
//       "briefing_id": "<uuid>",        // ecoado do payload de entrada
//       "empresa": "<string>",          // ecoado
//       "briefing_markdown": "<markdown completo>",
//       "error": "<opcional, se Routine falhou>"
//     }
//
// Seguranca: valida X-Routine-Secret contra integracao_config.
// Idempotente: se status ja eh 'completed' e markdown eh o mesmo,
// retorna 200 sem alterar.
// =============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-routine-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function getSupabaseAdmin() {
    return createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )
}

async function validateSecret(supabase: any, providedSecret: string | null): Promise<boolean> {
    if (!providedSecret) return false
    const { data } = await supabase
        .from('integracao_config')
        .select('value')
        .eq('key', 'prep_call_callback_secret')
        .single()
    return !!data?.value && data.value === providedSecret
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

        // Auth por secret
        const secret = req.headers.get('X-Routine-Secret') || req.headers.get('x-routine-secret')
        const validSecret = await validateSecret(supabase, secret)
        if (!validSecret) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const body = await req.json()
        const briefingId: string | undefined = body.briefing_id
        const briefingMarkdown: string | undefined = body.briefing_markdown
        const briefingJsonFromBody: any = body.briefing_json // Routine pode enviar direto
        const errorMsg: string | undefined = body.error

        if (!briefingId) {
            return new Response(JSON.stringify({ error: 'missing briefing_id' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Buscar registro
        const { data: existing, error: selErr } = await supabase
            .from('prep_briefings')
            .select('id, status, briefing_markdown, version, scraped_data')
            .eq('id', briefingId)
            .maybeSingle()

        if (selErr || !existing) {
            return new Response(JSON.stringify({ error: 'briefing not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Idempotencia: se ja esta completed com mesmo markdown, no-op
        if (existing.status === 'completed' && existing.briefing_markdown === briefingMarkdown) {
            return new Response(JSON.stringify({ ok: true, idempotent: true }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const update: Record<string, any> = {
            completed_at: new Date().toISOString(),
        }

        // Parse do JSON estruturado: body.briefing_json tem prioridade, senao extrai do markdown.
        let briefingJson: any = null
        let schemaVersion: string | null = null

        if (briefingJsonFromBody && typeof briefingJsonFromBody === 'object') {
            briefingJson = briefingJsonFromBody
            schemaVersion = briefingJson?.schema_version || 'v1'
        } else if (briefingMarkdown) {
            // Tenta extrair ```json ... ``` apos marcador "## BRIEFING JSON"
            const m = briefingMarkdown.match(/##\s*BRIEFING\s+JSON[\s\S]*?```json\s*([\s\S]*?)```/i)
            if (m && m[1]) {
                try {
                    briefingJson = JSON.parse(m[1])
                    schemaVersion = briefingJson?.schema_version || 'v1'
                } catch (e) {
                    console.warn('failed to parse briefing_json from markdown:', e)
                }
            }
        }

        if (errorMsg) {
            update.status = 'error'
            update.progress_stage = 'error'
            update.error_message = errorMsg
        } else if (briefingMarkdown) {
            update.status = 'completed'
            update.progress_stage = 'completed'
            update.briefing_markdown = briefingMarkdown
            update.error_message = null
            if (briefingJson) {
                update.briefing_json = briefingJson
                update.schema_version = schemaVersion
            }
        } else {
            return new Response(JSON.stringify({ error: 'missing briefing_markdown or error' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        const { error: updErr } = await supabase
            .from('prep_briefings')
            .update(update)
            .eq('id', briefingId)

        if (updErr) {
            return new Response(JSON.stringify({ error: updErr.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            })
        }

        // Historico de versoes: snapshot sempre que completou com sucesso.
        if (update.status === 'completed') {
            const snapshot = {
                briefing_id: briefingId,
                version: existing.version || 1,
                briefing_markdown: briefingMarkdown || null,
                briefing_json: briefingJson,
                schema_version: schemaVersion,
                scraped_data: existing.scraped_data || null,
            }
            const { error: vErr } = await supabase
                .from('prep_briefings_versions')
                .insert(snapshot)
            if (vErr) {
                console.warn('failed to snapshot version:', vErr.message)
                // nao falha a request principal
            }
        }

        return new Response(JSON.stringify({ ok: true, has_json: !!briefingJson }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    } catch (e: any) {
        console.error('prep-call-callback error:', e)
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }
})
