## Notas de sesión — 4 jun 2026

**Seguridad RLS verificada:** las tres tablas (profiles, historial, analysis_cache) tienen RLS activado (true). Las políticas de profiles e historial están atadas correctamente a auth.uid(). Los datos de los usuarios están protegidos.

**Pendiente del caché (no urgente):** la tabla analysis_cache tiene política de lectura USING (true) = lectura pública. No es riesgo de privacidad (no hay datos personales), pero es una fuga del producto de pago. El navegador lee/escribe el caché directo con la anon key vía src/supabase.js (getCachedAnalysis líneas 37-47, saveAnalysisCache líneas 49-57), disparado desde src/App.jsx (lee línea 752, escribe línea 1046). El servidor (api/) NO toca el caché.

**Decisión:** el arreglo completo del caché (mover lectura/escritura a api/analyze.js con service_role + cerrar la regla en Supabase) se hará JUNTO con la integración de pagos (candidato: Kunfupay), porque ambos tocan validación de planes en el servidor.

**Carpeta de trabajo correcta:** C:\dev\Betiq-pro (clonada de GitHub, fuera de OneDrive). La carpeta vieja en OneDrive\escritorio\BetScore IA estaba aplanada y sin /api; NO usarla.

## Notas de sesión — 23 ago 2026

## Notas de sesión — 24 ago 2026

**Endpoints protegidos:** api/analyze y api/football exigen el access_token de Supabase (Authorization: Bearer) y responden 401 ANTES de gastar; el guard compartido vive en api/_auth.js (el prefijo _ lo excluye del enrutado de Vercel). api/fixtures queda público a propósito: el calendario es la portada. maxTokens se capa en el servidor a 4000. El candidato de pagos es Kunfupay (no Stripe).

**Trampa conocida — standings multi-grupo:** /standings devuelve VARIOS grupos en ligas con etapas (Colombia 2: Apertura+Clausura; Argentina 4: etapa x zona A/B; Uruguay 5: Tabla Anual, Promedios, Intermedio, Apertura, Clausura). Aplanar y tomar el primer hallazgo sirve la tabla del Apertura terminado como vigente. La regla correcta (api/football.js, seccion 7): elegir el grupo que case con la etapa que nombra el propio fixture en league.round ("Clausura - 8"), por equipo; con un solo grupo no hay ambiguedad; si ninguno casa, el campo `tabla` declara "sin etapa identificada" y las posiciones van vacias — nunca fingir certeza con grupos[0]. /teams/statistics cubre la temporada entera (etapas sumadas), etiquetado en `stats_periodo`.

**Pendientes de seguridad:**
- Fase 2 del proxy de analyze: dejar de aceptar system/messages arbitrarios del cliente; el prompt se armará en el servidor.
- Cuota en servidor: cierra el bypass de un usuario logueado llamando a los endpoints con curl (token válido, cuota sin cobrar). Va junto con la fase de pagos (Kunfupay).
- analysis_cache sigue con lectura pública USING (true) hasta la fase de pagos.

**Pendiente del timeout de Vercel (resolver junto con el cron):** con 17 ligas, la carga en frío total de /api/fixtures (instancia nueva: timezone + 17 temporadas + 17 fixtures) mide 7.5s reales; si además salta la ronda de reintentos de ligas caídas (+1.5s de pausa + tandas) puede rozar los 10s de timeout por defecto de Vercel Hobby. Es el caso raro (primer arranque + fallos simultáneos). Opciones al montar el cron: subir maxDuration en vercel.json y/o precachear temporadas.
