-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-10 — Arbitros: filas crudas por partido (Recetario v2c, pieza 1)
--
-- Objetivo: tabla `arbitro_partidos` con UNA fila por partido jugado con
-- referee informado — tarjetas del partido incluidas. A PROPOSITO no hay
-- tabla de agregados: los promedios (tarjetas/partido de un arbitro) se
-- calculan al LEER, recomputables y honestos, y una fila mala se corrige
-- sola al re-sembrar. La sonda de arbitros (5/8-sep) midio el terreno:
-- referee ~90%+ poblado en historico y texto libre con pais y abreviados.
--
-- arbitro_clave es la llave normalizada (normalizarArbitro en
-- api/_analysis.js: sin ", Pais", sin tildes ni puntos, minusculas);
-- arbitro_display conserva la forma humana. El cruce abreviado↔completo
-- ("G. Pereira" vs "Gustavo Pereira") NO se resuelve al escribir: vive
-- en la lectura (pieza 3) con la regla del candidato unico.
--
-- amarillas/rojas NULL = estadisticas no disponibles para ese fixture
-- (distinto de 0, que es un partido sin tarjetas).
--
-- Lectura: publica (anon y authenticated) — no hay dato sensible.
-- Escritura: SOLO service_role (salta RLS por definicion); sin politicas
-- de INSERT/UPDATE/DELETE, el mismo candado que analysis_cache/estadios.
--
-- Idempotente: se puede correr mas de una vez sin efecto adicional.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.arbitro_partidos (
  fixture_id      integer PRIMARY KEY,  -- id numerico de API-Football
  arbitro_clave   text,                 -- llave normalizada (agrupa)
  arbitro_display text,                 -- forma humana (se muestra)
  liga_id         integer,
  fecha           date,
  amarillas       integer,              -- NULL = stats no disponibles
  rojas           integer
);

ALTER TABLE public.arbitro_partidos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "arbitro_partidos_select" ON public.arbitro_partidos;
CREATE POLICY "arbitro_partidos_select" ON public.arbitro_partidos
  FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE public.arbitro_partidos IS
  'Filas crudas por partido jugado con referee (tarjetas incluidas; NULL = stats no disponibles). Promedios al leer. Sembrada por el cocinero --sembrar-arbitros. Lectura publica; escritura solo service_role.';

COMMIT;

-- ── Verificacion (misma corrida) ─────────────────────────────────────
-- 1) La tabla existe y RLS esta activado (rls_activado = true):
SELECT relname, relrowsecurity AS rls_activado
FROM pg_class WHERE relname = 'arbitro_partidos';

-- 2) Exactamente UNA politica, y solo SELECT:
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'arbitro_partidos';

-- 3) Las columnas, en orden (amarillas/rojas integer y nullable):
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'arbitro_partidos'
ORDER BY ordinal_position;
