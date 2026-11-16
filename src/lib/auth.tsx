import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { backendReady, supabase, supabaseUrl } from './supabase'
import { FRESH, useGame, type GameState } from './store'
import { navigate } from './util'

// Players log in with a USERNAME + password. Supabase wants an email, so we derive a private
// one from the username. The Netlify registration function confirms accounts server-side;
// the derived address is never used for email delivery.
const emailFor = (u: string) => `${u.trim().toLowerCase()}@players.cosmicdetective.app`
const PENDING_GUEST_RECOVERY = 'cosmic-detective:pending-guest-recovery:v1'
export const USERNAME_RULE = /^[A-Za-z0-9_.]{3,20}$/

interface AuthApi {
  /** true once we know whether someone is already signed in */
  ready: boolean
  userId: string | null
  username: string | null
  /** resolves to true when the player has already finished the tutorial */
  signUp: (username: string, password: string) => Promise<boolean>
  signIn: (username: string, password: string) => Promise<boolean>
  signOut: () => Promise<void>
  /** push the latest progress to the server right now */
  syncNow: () => Promise<void>
}
const AuthCtx = createContext<AuthApi>(null!)
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { s, set } = useGame()
  const [ready, setReady] = useState(!backendReady)
  const [userId, setUserId] = useState<string | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const sRef = useRef(s); sRef.current = s
  const loadedFor = useRef<string | null>(null) // never upload before the server save has been loaded
  const pendingRecovery = useRef<string | null>(null)

  const push = useCallback(async () => {
    const cur = sRef.current
    const save = { ...cur, rankUp: null, last: null, presenter: false }
    const { error } = await supabase.rpc('sync_progress', {
      p_tiles: cur.tiles, p_xp: cur.xp, p_correct: cur.correct, p_judged: cur.judged, p_save: save,
    })
    if (error) console.warn('Progress sync failed:', error.message)
  }, [])

  /** Load this player's server save into the game. */
  const hydrate = useCallback(async (uid: string, name: string, keepLocal: boolean): Promise<boolean> => {
    const [saveRes, profRes] = await Promise.all([
      supabase.from('saves').select('data').eq('user_id', uid).maybeSingle(),
      supabase.from('profiles').select('tiles').eq('id', uid).maybeSingle(),
    ])
    const remote = (saveRes.data?.data ?? {}) as Partial<GameState>
    const serverTiles = profRes.data?.tiles ?? 0
    const local = sRef.current
    const sameDevice = local.callsign === name && local.xp >= (remote.xp ?? 0)
    let next: GameState = keepLocal || sameDevice
      ? { ...local }
      : { ...FRESH, theme: local.theme, colorblind: local.colorblind, sound: local.sound, ...remote }
    next = { ...next, callsign: name, started: true, rankUp: null, presenter: false, last: null }
    if (serverTiles > next.tiles) next.tiles = serverTiles // e.g. promoted in the database
    set(() => next)
    loadedFor.current = uid
    setUserId(uid)
    setUsername(name)
    return next.tutorialDone
  }, [set])

  // Restore a session after a page refresh.
  useEffect(() => {
    if (!backendReady) return
    supabase.auth.getSession().then(async ({ data }) => {
      const u = data.session?.user
      if (u) await hydrate(u.id, (u.user_metadata?.username as string) || 'Detective', false)
      setReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { loadedFor.current = null; setUserId(null); setUsername(null) }
    })
    return () => sub.subscription.unsubscribe()
  }, [hydrate])

  // Auto-save progress 2 seconds after the last change.
  useEffect(() => {
    if (!userId || loadedFor.current !== userId) return
    const t = setTimeout(() => { void push() }, 2000)
    return () => clearTimeout(t)
  }, [s, userId, push])

  const signUp = useCallback(async (name: string, password: string) => {
    name = name.trim()
    if (!USERNAME_RULE.test(name)) throw new Error('Username: 3 to 20 characters, using letters, numbers, _ or . only.')
    if (password.length < 6) throw new Error('Password needs at least 6 characters.')
    const supabaseHost = supabaseUrl ? new URL(supabaseUrl).host.toLowerCase() : ''
    const response = await fetch('/.netlify/functions/register-player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password, supabaseHost }),
    })
    const result = await response.json().catch(() => ({})) as { error?: string }
    if (response.status === 429) throw new Error('Too many account creation attempts. Please wait a minute and try again.')
    if (!response.ok) throw new Error(result.error || 'Could not create the account. Please try again.')
    // Keep the guest save if account creation succeeds but the following login
    // request fails. This marker survives a reload and is consumed on login to
    // this same username only.
    pendingRecovery.current = name.toLowerCase()
    try { localStorage.setItem(PENDING_GUEST_RECOVERY, JSON.stringify({ username: name.toLowerCase() })) } catch { /* in-memory recovery still covers this page */ }
    const { data, error } = await supabase.auth.signInWithPassword({ email: emailFor(name), password })
    if (error) throw new Error(`Account created, but sign-in failed: ${error.message}`)
    const done = await hydrate(data.user.id, name, true) // a brand-new account keeps the progress you already made as a guest
    pendingRecovery.current = null
    try { localStorage.removeItem(PENDING_GUEST_RECOVERY) } catch { /* ignore unavailable storage */ }
    return done
  }, [hydrate])

  const signIn = useCallback(async (name: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email: emailFor(name), password })
    if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Wrong username or password.' : error.message)
    const accountName = (data.user.user_metadata?.username as string) || name.trim()
    let recoverGuest = pendingRecovery.current === accountName.toLowerCase()
    if (!recoverGuest) {
      try {
        const pending = JSON.parse(localStorage.getItem(PENDING_GUEST_RECOVERY) || 'null') as { username?: unknown } | null
        recoverGuest = typeof pending?.username === 'string' && pending.username.toLowerCase() === accountName.toLowerCase()
      } catch { /* no pending recovery marker */ }
    }
    const done = await hydrate(data.user.id, accountName, recoverGuest)
    if (recoverGuest) {
      pendingRecovery.current = null
      try { localStorage.removeItem(PENDING_GUEST_RECOVERY) } catch { /* ignore unavailable storage */ }
    }
    return done
  }, [hydrate])

  const signOut = useCallback(async () => {
    await push()
    await supabase.auth.signOut()
    loadedFor.current = null; setUserId(null); setUsername(null)
    set((p) => ({ ...FRESH, theme: p.theme, colorblind: p.colorblind, sound: p.sound }))
    navigate('/')
  }, [push, set])

  const api = useMemo<AuthApi>(() => ({ ready, userId, username, signUp, signIn, signOut, syncNow: push }), [ready, userId, username, signUp, signIn, signOut, push])
  return <AuthCtx.Provider value={api}>{children}</AuthCtx.Provider>
}
