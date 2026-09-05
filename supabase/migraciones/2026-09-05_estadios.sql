-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-05 — Estadios y mapa equipo→estadio (Recetario v2b, paso 1)
--
-- Objetivo: dos tablas para el factor altitud. `estadios` guarda cada
-- estadio por su venue_id numerico de API-Football (nunca por nombre);
-- la columna altitud_m nace NULL y se rellena A MANO — el sembrador
-- (cocinero --sembrar-estadios) no la envia jamas, asi que re-sembrar
-- no la pisa. `equipos_estadio` es el mapa equipo→estadio habitual,
-- necesario para el efecto "visitante que sube": la altitud de ORIGEN
-- del visitante sale de su propio estadio.
--
-- Lectura: publica (anon y authenticated) — no hay dato sensible y el
-- cliente podra leerla en generacion en vivo. Escritura: SOLO
-- service_role, que salta RLS por definicion; sin politicas de
-- INSERT/UPDATE/DELETE, el mismo candado que analysis_cache.
--
-- La lectura de altitud por el recetario NO existe todavia: llegara con
-- receta: 3 (este es solo el paso 1: nacer versionadas y sembrarse).
--
-- Idempotente: se puede correr mas de una vez sin efecto adicional.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.estadios (
  venue_id  integer PRIMARY KEY,  -- id numerico de API-Football
  nombre    text,
  ciudad    text,
  pais      text,
  altitud_m integer               -- NULL hasta rellenarse a mano
);

CREATE TABLE IF NOT EXISTS public.equipos_estadio (
  team_id  integer PRIMARY KEY,   -- id numerico de API-Football
  equipo   text,
  venue_id integer,               -- estadio habitual (sin FK a proposito:
  liga_id  integer                -- el sembrador upsertea sin orden)
);

ALTER TABLE public.estadios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.equipos_estadio ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "estadios_select" ON public.estadios;
CREATE POLICY "estadios_select" ON public.estadios
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "equipos_estadio_select" ON public.equipos_estadio;
CREATE POLICY "equipos_estadio_select" ON public.equipos_estadio
  FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE public.estadios IS
  'Estadios por venue_id de API-Football. altitud_m se rellena A MANO; el sembrador jamas la envia. Lectura publica; escritura solo service_role.';

COMMENT ON TABLE public.equipos_estadio IS
  'Mapa equipo->estadio habitual (altitud de ORIGEN del visitante). Sembrado por el cocinero --sembrar-estadios. Lectura publica; escritura solo service_role.';

COMMIT;

-- ── Verificacion (misma corrida) ─────────────────────────────────────
-- 1) Las dos tablas existen y RLS esta activado (rls_activado = true):
SELECT relname, relrowsecurity AS rls_activado
FROM pg_class WHERE relname IN ('estadios', 'equipos_estadio');

-- 2) Exactamente UNA politica por tabla, y solo SELECT:
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('estadios', 'equipos_estadio')
ORDER BY tablename;

-- 3) Las columnas, en orden (altitud_m integer y nullable):
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('estadios', 'equipos_estadio')
ORDER BY table_name, ordinal_position;
