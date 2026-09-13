-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-13 — Historial profesional (registro manual + resolucion + KPIs)
--
-- Objetivo: columnas para que `historial` sostenga un registro de picks
-- de verdad — estado canonico con CHECK, cuota de cierre (CLV), casa,
-- marca de registro manual — y banca persistente en `profiles`.
--
-- Estado real (verificado contra el cliente, 13-sep-2026): la tabla la
-- escribe el cliente con anon+sesion via upsert; ya tiene `resultado`
-- (texto libre en MAYUSCULAS), `monto_apostado`, `ganancia`, `partido`.
-- NO tiene fixture_id (nada que volver nullable). La RLS quedo atada a
-- auth.uid() (verificada en pg_policies el 4-jun), pero sin politica
-- UPDATE la resolucion de picks caeria en el mismo bug latente que
-- analysis_cache (DO UPDATE fallando en silencio, 1-sep): aqui se añade.
-- `estado` (minusculas) es el canonico nuevo; `resultado` queda como
-- dialecto legado del cliente y ambos se escriben en paralelo.
--
-- DELETE: el boton de borrar existe en la UI desde antes; sin politica
-- DELETE los borrados resucitarian en cada merge nube→local. Se añade
-- (filas propias) — es la unica politica extra ademas del UPDATE pedido.
--
-- profiles.banca: el cliente YA actualiza profiles (analisis_hoy), asi
-- que la politica UPDATE propia existe; solo falta la columna.
--
-- Idempotente: se puede correr mas de una vez sin efecto adicional.
-- ─────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.historial
  ADD COLUMN IF NOT EXISTS estado        text NOT NULL DEFAULT 'pendiente',
  ADD COLUMN IF NOT EXISTS cuota_cierre  numeric,
  ADD COLUMN IF NOT EXISTS casa          text,
  ADD COLUMN IF NOT EXISTS es_manual     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS partido       text;  -- ya existe: no-op documentado

ALTER TABLE public.historial DROP CONSTRAINT IF EXISTS historial_estado_check;
ALTER TABLE public.historial ADD CONSTRAINT historial_estado_check
  CHECK (estado IN ('pendiente', 'ganada', 'perdida', 'nula'));

-- Backfill del legado: filas viejas con resultado marcado pero estado
-- virgen. Idempotente: tras la primera pasada, estado ya no es
-- 'pendiente' para esas filas y el WHERE no vuelve a casar.
UPDATE public.historial SET estado = CASE resultado
  WHEN 'GANADA'  THEN 'ganada'
  WHEN 'PERDIDA' THEN 'perdida'
  WHEN 'ANULADA' THEN 'nula'
  ELSE 'pendiente' END
WHERE estado = 'pendiente' AND resultado IS NOT NULL AND resultado <> 'PENDIENTE';

-- Resolver picks y editar stake/cierre exige UPDATE de filas propias.
DROP POLICY IF EXISTS "historial_update_propio" ON public.historial;
CREATE POLICY "historial_update_propio" ON public.historial
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Borrar filas propias (ver cabecera: sin esto, los borrados resucitan).
DROP POLICY IF EXISTS "historial_delete_propio" ON public.historial;
CREATE POLICY "historial_delete_propio" ON public.historial
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Banca persistente: una sola banca para todas las pantallas.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS banca numeric NOT NULL DEFAULT 1000;

COMMIT;

-- ── Verificacion (misma corrida) ─────────────────────────────────────
-- 1) Politicas de historial: deben aparecer SELECT/INSERT previas + el
--    UPDATE (con with_check) y DELETE nuevos, todas atadas a auth.uid():
SELECT policyname, cmd, qual AS using_expr, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'historial'
ORDER BY cmd, policyname;

-- 2) Columnas nuevas de historial (estado NOT NULL default pendiente):
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'historial'
  AND column_name IN ('estado', 'cuota_cierre', 'casa', 'es_manual', 'partido')
ORDER BY column_name;

-- 3) El CHECK de estado y la banca en profiles:
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE conname = 'historial_estado_check';
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'banca';
