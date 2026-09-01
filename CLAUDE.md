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

## Notas de sesión — 1 sep 2026

**Candado de la despensa (cron paso 2):** el cliente ya no escribe analysis_cache — se eliminaron la llamada y la función saveAnalysisCache, y la migración supabase/migraciones/2026-09-01_candado_analysis_cache.sql borra cache_insert (la única política de escritura). Solo service_role escribe: el cron (paso 3) y, en fase 2, el servidor. La lectura pública (cache_select, USING true) queda abierta documentada hasta la fase de pagos.

**Modelo de amenaza corregido (fuente: pg_policies, 1-sep):** cache_insert exigía auth.role()='authenticated' — la escritura NUNCA estuvo abierta a anónimos. El riesgo de envenenamiento del caché era de miembros logueados, no de extraños. (La lectura sí es pública.)

**Bug latente resuelto por diseño:** nunca existió política UPDATE en analysis_cache, así que la rama DO UPDATE del upsert del cliente jamás pudo refrescar una fila existente — fallaba en silencio (llamada sin await ni manejo de error). Con la escritura en service_role (salta RLS) el refresco vuelve a ser posible donde corresponde.

**Interino "sin caché de análisis en vivo" hasta que el cron llene la despensa:** generar funciona igual; REABRIR un análisis nuevo regenera (y paga Claude) porque nada escribe el caché. Las filas ya existentes se siguen sirviendo (lectura intacta), incluidas las copias pre-partido de partidos empezados. Motivo para no demorar el paso 3.

## El cocinero (cron) — operación

**Turnos:** GitHub Actions, cron `0 */6 * * *` en UTC = 00/06/12/18 UTC = 10/16/22/04 en Sydney (AEST, UTC+10; en horario de verano AEDT, UTC+11, son las 11/17/23/05). También se puede disparar a mano desde Actions → cocinero (dry_run por defecto true: el botón no gasta por descuido).

**Cómo leer el cuaderno (cron_runs, solo service_role — SQL Editor):**
```sql
SELECT started_at, finished_at, generados, saltados_cacheados,
       saltados_sin_cuotas, fuera_de_tope, errores, podados
FROM cron_runs ORDER BY started_at DESC LIMIT 10;
```
finished_at NULL = corrida muerta a medias (timeout/crash). Sin filas nuevas en >6h = el scheduler no está corriendo. detalle (jsonb) guarda los errores por fixture y si saltó el cortacircuitos.

**Trampa de los 60 días:** GitHub Actions DESACTIVA los workflows con schedule tras 60 días sin commits en el repo, en silencio — y el fallback en vivo lo enmascara (la app sigue funcionando, solo que pagando generación por clic). La señal es cron_runs sin filas nuevas; se rearma con cualquier commit o con el botón "Enable workflow" en Actions.

**Optimización futura de costo:** la Batch API de Anthropic (−50% por token, latencia de horas) es ideal para el cocinero — un pre-caché no tiene prisa. Cuando el volumen crezca (Europa en sábado), migrar llamarClaude() a batches.

## Roadmap acordado (chat de diseño, 1 sep 2026)

El siguiente bloque NO es pagos. Orden acordado:

**1. RECETARIO v2** (siguiente bloque, empezando por lo barato):
- a) Línea fija de tabla en la cabecera del análisis, determinista desde el payload (grupo, fecha, posición y puntos de ambos equipos) — no desde el texto de la IA.
- b) ALTITUD: tabla propia en Supabase (estadios), esqueleto sembrado desde API-Football con ids numéricos de equipo y estadio (nunca por nombre), columna altitud rellenada a mano. El análisis busca por el id del estadio del fixture; si no está en la tabla, la línea de altitud NO aparece (silencio honesto). Efecto fuerte = visitante que sube; bajada = efecto débil; la IA compara siempre contra la cuota (los casos famosos ya están descontados por las casas).
- c) ÁRBITROS: tabla propia (arbitros) sembrada desde el histórico de API-Football — nunca desde portales web (esos solo como vara de control) — con normalización de nombres, mantenida por el cocinero con los partidos de ayer. El prompt solo usa números entregados, jamás inventa promedios; pick de tarjetas solo si existe la línea en las cuotas. Paso 0: diagnóstico de cuán poblado viene el campo referee en las 17 ligas. Plan B condicional: prueba gratis de Sportmonks (el plan Worldwide es caro: €129-219/mes).
- d) Opcional: etiqueta de versión de receta en el JSON del caché.

**2. PICK DEL DÍA:** motor de selección sobre la despensa (cuota mínima 1.40, máxima probabilidad, valor vs cuota implícita); salida web + imagen vertical (@vercel/og) + Telegram automático (bot) + WhatsApp manual; historial público de resultados (% acierto, yield); pick free diario + premium mensual. Nunca prometer aciertos garantizados.

**3. LANZAMIENTO Y PAGOS:** Kunfupay junto con la fase 2 del proxy, la cuota en servidor y el cierre del USING(true) (los tres pendientes de seguridad de arriba). Política de privacidad (pendiente: 4 datos de Sebas). Google OAuth branding: nombre "BetFut", soporte betfut.co@gmail.com, dominio verificado. Facebook login. Paquete del día uno: Supabase Pro ($25/mes) + dominio propio para auth ($10). Opcional posterior: federación de identidades en Anthropic en vez de API key estática.

**4. Menores conocidos:** el login vuelve a la portada y no al partido; el "#" en la URL tras login; panel de ligas en móvil; timeout de carga fría de fixtures; Batch API (−50%) cuando crezca el volumen.
