import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON) {
  console.warn('Supabase keys not configured — running in offline mode')
}

export const supabase = (SUPABASE_URL && SUPABASE_ANON)
  ? createClient(SUPABASE_URL, SUPABASE_ANON)
  : null

// ── Límites por plan ──────────────────────────────────────
export const PLAN_LIMITS = {
  free:    { analisis: 1,  label: 'Free',    color: '#22c55e' },
  premium: { analisis: 3,  label: 'Premium', color: '#f59e0b' },
  vip:     { analisis: 999, label: 'VIP',    color: '#a855f7' },
}

// ── Auth helpers ──────────────────────────────────────────
export const loginGoogle = () =>
  supabase?.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  })

export const loginFacebook = () =>
  supabase?.auth.signInWithOAuth({
    provider: 'facebook',
    options: { redirectTo: window.location.origin }
  })

export const logout = () => supabase?.auth.signOut()

// ── Cache helpers ─────────────────────────────────────────
export const getCachedAnalysis = async (local, visitante) => {
  if (!supabase) return null
  const key = `${local.toLowerCase().trim()}|${visitante.toLowerCase().trim()}`
  const { data } = await supabase
    .from('analysis_cache')
    .select('analysis, expires_at')
    .eq('match_key', key)
    .gt('expires_at', new Date().toISOString())
    .single()
  return data?.analysis || null
}

export const saveAnalysisCache = async (local, visitante, analysis) => {
  if (!supabase) return
  const key = `${local.toLowerCase().trim()}|${visitante.toLowerCase().trim()}`
  await supabase.from('analysis_cache').upsert({
    match_key:  key,
    local, visitante, analysis,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  }, { onConflict: 'match_key' })
}

// ── Profile helpers ───────────────────────────────────────
export const getProfile = async (userId) => {
  if (!supabase) return null
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single()
  return data
}

export const checkAndIncrementAnalysis = async (userId) => {
  if (!supabase) return { allowed: true }
  const profile = await getProfile(userId)
  if (!profile) return { allowed: true }

  const today = new Date().toISOString().split('T')[0]
  const limit = PLAN_LIMITS[profile.plan]?.analisis || 1

  // Reset contador si es un nuevo día
  if (profile.fecha_reset !== today) {
    await supabase.from('profiles').update({
      analisis_hoy: 1,
      fecha_reset: today
    }).eq('id', userId)
    return { allowed: true, usado: 1, limite: limit, plan: profile.plan }
  }

  if (profile.analisis_hoy >= limit) {
    return { allowed: false, usado: profile.analisis_hoy, limite: limit, plan: profile.plan }
  }

  await supabase.from('profiles').update({
    analisis_hoy: profile.analisis_hoy + 1
  }).eq('id', userId)

  return { allowed: true, usado: profile.analisis_hoy + 1, limite: limit, plan: profile.plan }
}

// ── Historial helpers ─────────────────────────────────────
export const saveHistorialSupabase = async (userId, record) => {
  if (!supabase || !userId) return false
  const { error } = await supabase.from('historial').upsert({
    id:             record.id,
    user_id:        userId,
    fecha_analisis: record.fecha_analisis,
    hora_analisis:  record.hora_analisis,
    partido:        record.partido,
    local:          record.local,
    visitante:      record.visitante,
    competicion:    record.competicion,
    fecha_partido:  record.fecha_partido,
    mercado:        record.mercado_1,
    descripcion:    record.desc_1,
    cuota:          record.cuota_1,
    ev:             record.ev_1,
    confianza:      String(record.confianza_1),
    fuente:         record.fuente_1,
    resultado:      record.resultado,
    monto_apostado: record.monto_apostado,
    ganancia:       record.ganancia_unidades,
    categoria:      record.categoria,
  })
  return !error
}

export const loadHistorialSupabase = async (userId) => {
  if (!supabase || !userId) return null
  const { data, error } = await supabase
    .from('historial')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) return null
  return data?.map(r => ({
    id:               r.id,
    fecha_analisis:   r.fecha_analisis,
    hora_analisis:    r.hora_analisis,
    partido:          r.partido,
    local:            r.local,
    visitante:        r.visitante,
    competicion:      r.competicion,
    fecha_partido:    r.fecha_partido,
    mercado_1:        r.mercado,
    desc_1:           r.descripcion,
    cuota_1:          r.cuota,
    ev_1:             r.ev,
    confianza_1:      r.confianza,
    fuente_1:         r.fuente,
    resultado:        r.resultado,
    monto_apostado:   r.monto_apostado,
    ganancia_unidades: r.ganancia,
    categoria:        r.categoria,
  })) || []
}
