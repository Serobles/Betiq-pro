## Notas de sesión — 4 jun 2026

**Seguridad RLS verificada:** las tres tablas (profiles, historial, analysis_cache) tienen RLS activado (true). Las políticas de profiles e historial están atadas correctamente a auth.uid(). Los datos de los usuarios están protegidos.

**Pendiente del caché (no urgente):** la tabla analysis_cache tiene política de lectura USING (true) = lectura pública. No es riesgo de privacidad (no hay datos personales), pero es una fuga del producto de pago. El navegador lee/escribe el caché directo con la anon key vía src/supabase.js (getCachedAnalysis líneas 37-47, saveAnalysisCache líneas 49-57), disparado desde src/App.jsx (lee línea 752, escribe línea 1046). El servidor (api/) NO toca el caché.

**Decisión:** el arreglo completo del caché (mover lectura/escritura a api/analyze.js con service_role + cerrar la regla en Supabase) se hará JUNTO con la integración de Stripe, porque ambos tocan validación de planes en el servidor.

**Carpeta de trabajo correcta:** C:\dev\Betiq-pro (clonada de GitHub, fuera de OneDrive). La carpeta vieja en OneDrive\escritorio\BetScore IA estaba aplanada y sin /api; NO usarla.

## Notas de sesión — 23 ago 2026

**Pendiente del timeout de Vercel (resolver junto con el cron):** con 17 ligas, la carga en frío total de /api/fixtures (instancia nueva: timezone + 17 temporadas + 17 fixtures) mide 7.5s reales; si además salta la ronda de reintentos de ligas caídas (+1.5s de pausa + tandas) puede rozar los 10s de timeout por defecto de Vercel Hobby. Es el caso raro (primer arranque + fallos simultáneos). Opciones al montar el cron: subir maxDuration en vercel.json y/o precachear temporadas.
