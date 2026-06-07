## Notas de sesión — 4 jun 2026

**Seguridad RLS verificada:** las tres tablas (profiles, historial, analysis_cache) tienen RLS activado (true). Las políticas de profiles e historial están atadas correctamente a auth.uid(). Los datos de los usuarios están protegidos.

**Pendiente del caché (no urgente):** la tabla analysis_cache tiene política de lectura USING (true) = lectura pública. No es riesgo de privacidad (no hay datos personales), pero es una fuga del producto de pago. El navegador lee/escribe el caché directo con la anon key vía src/supabase.js (getCachedAnalysis líneas 37-47, saveAnalysisCache líneas 49-57), disparado desde src/App.jsx (lee línea 752, escribe línea 1046). El servidor (api/) NO toca el caché.

**Decisión:** el arreglo completo del caché (mover lectura/escritura a api/analyze.js con service_role + cerrar la regla en Supabase) se hará JUNTO con la integración de Stripe, porque ambos tocan validación de planes en el servidor.

**Carpeta de trabajo correcta:** C:\dev\Betiq-pro (clonada de GitHub, fuera de OneDrive). La carpeta vieja en OneDrive\escritorio\BetScore IA estaba aplanada y sin /api; NO usarla.
