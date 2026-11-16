import { createClient } from '@supabase/supabase-js'

const USERNAME_RULE = /^[A-Za-z0-9_.]{3,20}$/
const EMAIL_DOMAIN = 'players.cosmicdetective.app'

// Enforced by Netlify before this function runs. The same endpoint is the only
// public path to privileged account creation, so limit repeated attempts by IP.
export const config = {
  path: '/.netlify/functions/register-player',
  rateLimit: {
    windowLimit: 5,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return json({ error: 'Account registration is not configured on the server.' }, 503)

  let body
  try {
    const raw = await request.text()
    if (raw.length > 4096) return json({ error: 'Request is too large.' }, 413)
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'Request must contain valid JSON.' }, 400)
  }

  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!USERNAME_RULE.test(username)) return json({ error: 'Username: 3 to 20 characters, using letters, numbers, _ or . only.' }, 400)
  if (password.length < 6 || password.length > 256) return json({ error: 'Password must be between 6 and 256 characters.' }, 400)
  let serverHost
  try { serverHost = new URL(url).host.toLowerCase() } catch { return json({ error: 'Account registration has an invalid Supabase URL.' }, 503) }
  if (typeof body.supabaseHost !== 'string' || body.supabaseHost.toLowerCase() !== serverHost) {
    console.error('Player registration project mismatch:', { serverHost, clientHost: body.supabaseHost })
    return json({ error: 'Account registration points to a different Supabase project than sign-in. Set Netlify SUPABASE_URL to match the app’s VITE_SUPABASE_URL, then redeploy.' }, 503)
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
  // The auth trigger creates the profile, and its unique lower(username) index
  // enforces username availability atomically. Avoid a separate REST preflight,
  // which can fail independently due to PostgREST permissions or schema cache.
  const { error } = await admin.auth.admin.createUser({
    email: `${username.toLowerCase()}@${EMAIL_DOMAIN}`,
    password,
    email_confirm: true,
    user_metadata: { username },
  })
  if (error) {
    // The profile trigger enforces case-insensitive uniqueness and may win a race
    // against the availability check above.
    if (/profiles_username_key|already registered|already exists/i.test(error.message)) {
      return json({ error: 'That username is already taken. Try another.' }, 409)
    }
    console.error('Player account creation failed:', error.message)
    return json({ error: 'Could not create the account. Please try again.' }, 400)
  }

  return json({ ok: true })
}
