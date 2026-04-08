// Google OAuth callback - exchanges code for tokens and saves to team_members
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? ''
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? ''
const REDIRECT_URI = 'https://tawnlzdfykpwlhgmoprk.supabase.co/functions/v1/google-auth'
const SALESHUB_URL = 'http://localhost:3000'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  const url = new URL(req.url)
  const action = url.searchParams.get('action')

  // Step 1: Generate auth URL
  if (action === 'auth_url') {
    const memberId = url.searchParams.get('member_id')
    if (!memberId) return new Response('Missing member_id', { status: 400 })

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${GOOGLE_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly')}&` +
      `access_type=offline&` +
      `prompt=consent&` +
      `state=${memberId}`

    return new Response(JSON.stringify({ auth_url: authUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Step 2: OAuth callback - exchange code for tokens
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state') // member_id
  const error = url.searchParams.get('error')

  if (error) {
    return Response.redirect(`${SALESHUB_URL}?google_auth=error&msg=${error}`)
  }

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 })
  }

  try {
    // Exchange code for tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResp.ok) {
      const err = await tokenResp.text()
      console.error('Token exchange failed:', err)
      return Response.redirect(`${SALESHUB_URL}?google_auth=error&msg=token_exchange_failed`)
    }

    const tokens = await tokenResp.json()

    // Save tokens to team_members
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const expiryDate = new Date(Date.now() + (tokens.expires_in * 1000)).toISOString()

    await supabase.from('team_members').update({
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token || null,
      google_token_expiry: expiryDate,
      google_calendar_connected: true,
    }).eq('id', state)

    return Response.redirect(`${SALESHUB_URL}?google_auth=success`)
  } catch (e: any) {
    console.error('Google auth error:', e)
    return Response.redirect(`${SALESHUB_URL}?google_auth=error&msg=${e.message}`)
  }
})
