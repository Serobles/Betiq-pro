-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — El cuaderno del cocinero (cron, paso 3c)
--
-- Tabla cron_runs: registro de cada corrida REAL del cocinero (inicio,
-- fin, modo y contadores). Es lo que delata al scheduler muerto — la
-- trampa de GitHub Actions de apagarse solo tras 60 dias sin commits —
-- porque el fallback en vivo enmascara la ausencia de pre-generacion.
--
-- Seguridad: RLS ACTIVADO y CERO politicas — ni lectura ni escritura
-- publicas. Solo service_role (que salta RLS) escribe y lee: el propio
-- cocinero, y Sebas desde el SQL Editor.
--
-- Idempotente: se puede correr mas de una vez sin efecto adicional.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS public.cron_runs (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  modo                 text NOT NULL DEFAULT 'real',   -- 'real' | 'ensayo'
  encontrados          integer NOT NULL DEFAULT 0,     -- en ventana de 24h
  generados            integer NOT NULL DEFAULT 0,
  saltados_cacheados   integer NOT NULL DEFAULT 0,
  saltados_sin_cuotas  integer NOT NULL DEFAULT 0,     -- filtro rapido + compuerta definitiva
  fuera_de_tope        integer NOT NULL DEFAULT 0,     -- recortados por --max
  errores              integer NOT NULL DEFAULT 0,
  podados              integer NOT NULL DEFAULT 0,     -- filas de analysis_cache borradas (expiradas > 7 dias)
  detalle              jsonb                           -- errores con partido/id, cortacircuitos, etc.
);

ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.cron_runs IS
  'Cuaderno del cocinero (cron de pre-generacion). RLS sin politicas: solo service_role. Una fila por corrida real; finished_at NULL = corrida muerta a medias.';

COMMIT;

-- ── Verificacion (misma corrida) ─────────────────────────────────────
-- 1) La tabla existe y RLS esta activado (rls_activado = true):
SELECT relname, relrowsecurity AS rls_activado
FROM pg_class WHERE relname = 'cron_runs';

-- 2) CERO politicas (debe devolver 0):
SELECT count(*) AS politicas_debe_ser_0
FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cron_runs';

-- 3) Las columnas, en orden:
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'cron_runs'
ORDER BY ordinal_position;
