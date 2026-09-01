-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — Candado de la despensa (prerrequisito del cron, paso 2)
--
-- Objetivo: analysis_cache solo la escribe quien tenga service_role
-- (el cron en el paso 3 y, en fase 2, el servidor). El cliente dejo de
-- escribir en el deploy previo a esta migracion, asi que no hay ventana
-- de escrituras fallando.
--
-- Estado real verificado en pg_policies el 1-sep-2026 (4 filas):
--   analysis_cache: cache_insert (INSERT, WITH CHECK
--     auth.role()='authenticated') y cache_select (SELECT, USING true).
--   analisis_vistos: sus dos politicas propias — NO se tocan aqui.
--
-- Dos datos que esa consulta corrigio:
--   1) La escritura NUNCA estuvo abierta a anonimos: cache_insert exigia
--      authenticated. El modelo de amenaza real era "miembros logueados",
--      no extranos.
--   2) NUNCA existio politica UPDATE: la rama DO UPDATE del upsert del
--      cliente jamas pudo refrescar una fila existente y fallaba en
--      silencio (llamada sin await ni manejo de error). Bug latente que
--      este diseno resuelve: service_role salta RLS y si puede refrescar.
--
-- Idempotente: se puede correr mas de una vez sin efecto adicional.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

-- Unica politica de escritura existente. service_role no necesita
-- politica: salta RLS por definicion.
DROP POLICY IF EXISTS "cache_insert" ON public.analysis_cache;

-- La lectura publica se conserva A PROPOSITO y queda documentada en la
-- propia politica.
COMMENT ON POLICY "cache_select" ON public.analysis_cache IS
  'Lectura publica: abierta hasta la fase de pagos (Kunfupay). La escritura es solo service_role desde 2026-09-01 (cron / fase 2).';

COMMIT;

-- ── Verificacion (misma corrida): debe quedar SOLO cache_select ──────
SELECT tablename, policyname, cmd, roles, qual AS using_expr, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'analysis_cache'
ORDER BY cmd, policyname;
