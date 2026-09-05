// ── Logica PURA del analisis, compartida por tres consumidores ────────
// (1) el cliente (src/App.jsx, via Vite), (2) los endpoints de api/ y
// (3) el futuro script del cron. Regla de la casa: aqui NO entra nada que
// llame a API-Football, toque claves, ni dependa del navegador — sin
// import.meta.env, sin window/document, sin React. Este archivo viaja en
// el bundle del cliente: la frontera con el codigo de servidor es
// estructural, no de tree-shaking.
//
// Por que existe: el JSON que se guarda en analysis_cache lo pinta el
// cliente TAL CUAL en un cache-hit (sin re-normalizar), asi que quien
// genere — cliente hoy, cron manana — debe producir EXACTAMENTE la misma
// forma: mismo prompt, mismo parseo, misma normalizacion y mismos posts.
// Dos copias de esto divergirian en silencio.

export const SYSTEM_PROMPT = `Eres un analista de apuestas deportivas. Analiza el partido y devuelve SOLO el bloque JSON exacto.

REGLA ABSOLUTA: Tu respuesta debe empezar con ---JSON_START--- y terminar con ---JSON_END---. Nada mas.

El JSON tiene exactamente esta estructura (reemplaza los valores de ejemplo con datos reales del partido):
---JSON_START---
{"partido":{"local":"EQUIPO_LOCAL","visitante":"EQUIPO_VISITANTE","competicion":"LIGA","fecha":"FECHA","estadio":"ESTADIO"},"mercados_analizados":[{"nombre":"1X2 Victoria Local","descripcion":"gana el equipo local","cuota":1.45,"cuota_fuente":"Bet365","prob_real":72,"prob_implicita":69,"ev":0.04,"nivel_confianza":70,"recomendado":false,"ranking":6,"razon":"cuota sin valor suficiente"},{"nombre":"Doble Oportunidad 1X","descripcion":"local gana o empata","cuota":1.20,"cuota_fuente":"Bet365","prob_real":85,"prob_implicita":83,"ev":0.02,"nivel_confianza":82,"recomendado":false,"ranking":8,"razon":"sin valor por cuota baja"},{"nombre":"Draw No Bet Local","descripcion":"gana el local y si empatan devuelven la apuesta","cuota":1.35,"cuota_fuente":"Bet365","prob_real":78,"prob_implicita":74,"ev":0.05,"nivel_confianza":75,"recomendado":false,"ranking":5,"razon":"cubre el empate con valor moderado"},{"nombre":"Ambos Marcan Si","descripcion":"ambos equipos marcan","cuota":1.75,"cuota_fuente":"Bet365","prob_real":60,"prob_implicita":57,"ev":0.05,"nivel_confianza":60,"recomendado":false,"ranking":7,"razon":"valor moderado"},{"nombre":"Goles Over LINEA","descripcion":"mas goles que la linea que aparece en las cuotas reales","cuota":1.65,"cuota_fuente":"Bet365","prob_real":65,"prob_implicita":61,"ev":0.07,"nivel_confianza":63,"recomendado":true,"ranking":3,"razon":"buen promedio de goles de ambos"},{"nombre":"Goles Under LINEA","descripcion":"menos goles que la linea que aparece en las cuotas reales","cuota":2.10,"cuota_fuente":"Bet365","prob_real":35,"prob_implicita":48,"ev":-0.27,"nivel_confianza":35,"recomendado":false,"ranking":9,"razon":"sin valor"},{"nombre":"Handicap Asiatico Local LINEA","descripcion":"local con la linea de handicap que aparece en las cuotas reales","cuota":1.90,"cuota_fuente":"Bet365","prob_real":58,"prob_implicita":53,"ev":0.10,"nivel_confianza":65,"recomendado":true,"ranking":2,"razon":"buen valor por diferencia de nivel"},{"nombre":"Corners Over LINEA","descripcion":"mas corners que la linea que aparece en las cuotas reales","cuota":1.85,"cuota_fuente":"Bet365","prob_real":62,"prob_implicita":54,"ev":0.15,"nivel_confianza":68,"recomendado":true,"ranking":1,"razon":"mayor valor esperado del partido"},{"nombre":"Tarjetas Over LINEA","descripcion":"mas tarjetas que la linea que aparece en las cuotas reales","cuota":1.70,"cuota_fuente":"Bet365","prob_real":58,"prob_implicita":59,"ev":-0.01,"nivel_confianza":55,"recomendado":false,"ranking":4,"razon":"cuota ajustada al riesgo"}],"top_apuesta":{"nombre":"NOMBRE_DEL_MERCADO_CON_MAYOR_EV","descripcion":"descripcion del mercado elegido con su linea real","cuota":1.85,"cuota_fuente":"Bet365","prob_real":62,"prob_implicita":54,"ev":0.15,"nivel_confianza":68,"nivel_riesgo":"MEDIO","razon_ejecutiva":"Este mercado ofrece el mayor valor esperado del partido con probabilidad real superior a la implicita en la cuota."},"probabilidades_1x2":{"victoria_local":55,"empate":25,"victoria_visitante":20},"bajas":{"local":[{"nombre":"Jugador Ejemplo","posicion":"DC","es_titular":true}],"visitante":[]},"factores":{"forma_local":70,"forma_visitante":40,"presion_local":60,"motivacion_local":75,"motivacion_visitante":50,"cansancio_local":25,"cansancio_visitante":35},"puntos_clave":["El equipo local lleva 8 partidos invicto en casa","El visitante no gana fuera desde hace 5 jornadas","Diferencia de 20 puntos en la tabla"],"analisis_general":"El equipo local es favorito claro. El mercado de corners ofrece el mejor valor del encuentro."}
---JSON_END---

INSTRUCCION FINAL: Copia exactamente esa estructura JSON pero con los datos REALES del partido. No uses comillas dobles dentro de los valores de texto. Usa solo letras, numeros, espacios y puntos en los campos de texto. Donde el nombre de un mercado incluya la palabra LINEA, sustituyela por la linea numerica EXACTA que aparezca en las CUOTAS CLAVE de los datos reales; nunca inventes una linea que no este en esas cuotas.`;

// ── Resumen estructurado con datos reales de API-Football ─────────────
// f es el payload que devuelve el pipeline de football.js (encontrado=true).
export const construirSearchData = (f) => {
  const formatLesionados = (lista) =>
    lista.length > 0
      ? lista.map(l => `${l.nombre} — ${l.motivo || "Lesionado"} (${l.estado || "Estado no informado"})`).join(", ")
      : "Sin lesionados confirmados en API-Football";

  // Forma, tabla y promedios en una linea compacta por equipo
  const formatStats = (s, pos) => {
    if (!s && !pos) return "Sin datos estadisticos disponibles";
    return [
      `Pos:${pos?.pos ?? "N/D"} Pts:${pos?.pts ?? "N/D"} Forma:${s?.forma || pos?.forma || "N/D"}`,
      `PJ:${s?.partidos_jugados ?? 0} G:${s?.ganados ?? 0} E:${s?.empatados ?? 0} P:${s?.perdidos ?? 0}`,
      `GF:${s?.goles_favor ?? 0} GC:${s?.goles_contra ?? 0} (prom ${s?.promedio_goles_favor ?? "N/D"} a favor / ${s?.promedio_goles_contra ?? "N/D"} en contra)`,
      `Racha max ${s?.mayor_racha_victorias ?? 0}V ${s?.mayor_racha_derrotas ?? 0}D`,
      `Goles 1a parte:${s?.goles_primer_tiempo ?? 0}`,
    ].join(" | ");
  };

  // Mercados que el analisis necesita, con las lineas que interesan de
  // cada uno. Se seleccionan por NOMBRE, no por posicion en la respuesta:
  // la API devuelve ~99 mercados en orden arbitrario.
  const MERCADOS_CLAVE = [
    { etiqueta: "1X2",                nombres: ["Match Winner"],       lineas: ["Home", "Draw", "Away"] },
    { etiqueta: "Doble Oportunidad",  nombres: ["Double Chance"],      lineas: ["Home/Draw", "Home/Away", "Draw/Away"] },
    // API-Football publica el Draw No Bet bajo el nombre "Home/Away"
    { etiqueta: "Draw No Bet",        nombres: ["Draw No Bet", "Home/Away"], lineas: ["Home", "Away"] },
    { etiqueta: "Ambos Marcan",       nombres: ["Both Teams Score"],   lineas: ["Yes", "No"] },
    { etiqueta: "Goles Over/Under",   nombres: ["Goals Over/Under"],   lineas: ["Over 1.5", "Under 1.5", "Over 2.5", "Under 2.5", "Over 3.5", "Under 3.5"] },
    { etiqueta: "Handicap Asiatico",  nombres: ["Asian Handicap"],     lineas: ["Home -0.5", "Away -0.5", "Home -0.25", "Away -0.25", "Home 0", "Away 0"] },
    { etiqueta: "Corners Over/Under", nombres: ["Corners Over Under"], lineas: ["Over 8.5", "Under 8.5", "Over 9.5", "Under 9.5", "Over 10.5", "Under 10.5"] },
    { etiqueta: "Tarjetas Over/Under", nombres: ["Cards Over/Under"],  lineas: ["Over 3.5", "Under 3.5", "Over 4.5", "Under 4.5", "Over 5.5", "Under 5.5"] },
  ];

  const MAX_VALORES = 6;

  const bloqueCuotas = MERCADOS_CLAVE
    .map(({ etiqueta, nombres, lineas }) => {
      // Fallback 1: el mercado puede publicarse con otro nombre
      const m = (f.odds || []).find(o => nombres.includes(o.mercado));
      if (!m?.valores?.length) return null;
      // Fallback 2: si ninguna linea casa (las lineas varian por partido),
      // se cogen los primeros valores en vez de descartar el mercado
      const casan = m.valores.filter(v => lineas.includes(v.value));
      const vals = (casan.length ? casan : m.valores).slice(0, MAX_VALORES);
      // Cada linea dice de que casa salio, para que la IA no atribuya
      // todo a Bet365 al rellenar cuota_fuente.
      return `- ${etiqueta}: ${vals
        .map(v => `${v.value}=${v.odd}${v.casa ? ` (${v.casa})` : ""}`)
        .join(", ")}`;
    })
    .filter(Boolean)
    .join("\n") || "Sin cuotas disponibles";

  // Las cuotas ya no vienen solo de Bet365: se comparan dos casas y se
  // usa la mas conservadora de cada linea. La etiqueta lo refleja en vez
  // de seguir anunciando una sola casa.
  const casasTexto = (f.cuotas_casas || []).join(" y ");
  const tituloCuotas = casasTexto
    ? `CUOTAS CLAVE de ${casasTexto} — entre parentesis la casa de cada cuota, usala como cuota_fuente (usa EXACTAMENTE estas lineas, no inventes otras):`
    : "CUOTAS CLAVE (usa EXACTAMENTE estas lineas, no inventes otras):";

  return `DATOS REALES DE API-FOOTBALL (verificados):

PARTIDO: ${f.fixture?.local?.nombre} vs ${f.fixture?.visitante?.nombre}
LIGA: ${f.fixture?.liga} (${f.fixture?.pais}) | FECHA: ${f.fixture?.fecha}
TABLA: ${f.tabla || "N/D"} | Stats de equipo: ${f.stats_periodo || "temporada completa"}

FORMA Y ESTADISTICAS — ${f.fixture?.local?.nombre?.toUpperCase()} (LOCAL):
${formatStats(f.stats_local, f.posicion_local)}

FORMA Y ESTADISTICAS — ${f.fixture?.visitante?.nombre?.toUpperCase()} (VISITANTE):
${formatStats(f.stats_visitante, f.posicion_visitante)}

${tituloCuotas}
${bloqueCuotas}
${bloqueAltitud(f.altitud)}
BAJAS ${f.fixture?.local?.nombre?.toUpperCase()}:
${formatLesionados(f.lesionados_local)}

BAJAS ${f.fixture?.visitante?.nombre?.toUpperCase()}:
${formatLesionados(f.lesionados_visitante)}

CONTEXTO: ${f.fixture?.estadio || "N/D"}, ${f.fixture?.ciudad || "N/D"} | Arbitro: ${f.fixture?.arbitro || "Por confirmar"}
FUENTE: API-Football (datos oficiales en tiempo real)`;
};

// Bloque de altitud del prompt: solo con dato REAL del estadio del
// partido — sin dato, ni una palabra, que el modelo no improvise. El
// delta se firma (sube/baja) porque un visitante de altura que BAJA es
// el caso debil, no el fuerte. Va ANTES de las bajas a proposito: el
// recorte de 2500 del mensaje come por la cola, y un numero de altitud
// sin su regla anti-doble-conteo (o pintado en cabecera sin haber
// llegado al modelo) es peor que perder lineas de bajas.
const bloqueAltitud = (a) => {
  if (a?.partido_m == null) return "";
  const delta = a.visitante_origen_m != null ? a.partido_m - a.visitante_origen_m : null;
  const origen = delta != null
    ? `, visitante viene de ${a.visitante_origen_m} m (${delta >= 0 ? "sube" : "baja"} ~${Math.abs(delta)} m)`
    : "";
  return `
ALTITUD: partido a ${a.partido_m} m${origen}.
Instruccion de altitud: pesa sobre todo si el visitante sube mas de 1500 m; La Paz, Quito y Bogota ya las descuenta el mercado — señalala SOLO si la cuota no lo refleja; sin dato de altitud, ni mencionarla.
`;
};

// Sin datos de API-Football: Claude analiza con conocimiento propio
export const searchDataSinDatos = (local, visitante) =>
  `Partido: ${local} vs ${visitante} | Fecha: "próximos días".
Partido no encontrado en API-Football para esa fecha. Analiza basandote en tu conocimiento del historial,
forma reciente, estadísticas y contexto de ambos equipos. Usa cuotas estimadas realistas.`;

// Mensaje de usuario para Claude. El slice(2500) es parte del contrato:
// medido para que quepan las cuotas y las bajas sin desbordar el prompt.
export const construirMensajeUsuario = (local, visitante, searchData) =>
  `Partido: ${local} vs ${visitante} | Fecha: ${"Próximos días"}

DATOS REALES DE API-FOOTBALL:
${searchData.slice(0, 2500)}

FORMATO: responde SOLO con ---JSON_START--- {json} ---JSON_END---. Sin texto extra. Analiza 9 mercados. Cuota minima #1: 1.40.`;

// ── Parseo de la respuesta del modelo ─────────────────────────────────
// Extraccion por delimitadores — no falla aunque haya texto alrededor.
export const parsearRespuestaAnalisis = (jsonRaw) => {
  let raw = jsonRaw;
  const startMarker = "---JSON_START---";
  const endMarker = "---JSON_END---";
  const startIdx = raw.indexOf(startMarker);
  const endIdx = raw.lastIndexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1) {
    raw = raw.slice(startIdx + startMarker.length, endIdx).trim();
  } else {
    raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    const fb = raw.indexOf("{");
    const lb = raw.lastIndexOf("}");
    if (fb === -1 || lb === -1) throw new Error("No se encontró JSON en la respuesta del modelo");
    raw = raw.slice(fb, lb + 1);
  }

  // Limpiar JSON — fix newlines y comillas no escapadas dentro de strings
  const cleanJson = (str) => {
    let result = "";
    let inString = false;
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (inString) {
        if (ch === "\\" && i + 1 < str.length) {
          result += ch + str[i + 1]; i += 2; continue;
        }
        if (ch === '"') {
          // Detectar si es comilla de cierre mirando el siguiente char no-espacio
          let j = i + 1;
          while (j < str.length && str[j] === " ") j++;
          const nx = str[j];
          if (nx === ":" || nx === "," || nx === "}" || nx === "]" || nx === "\n" || nx === "\r" || j >= str.length) {
            inString = false; result += ch;
          } else {
            result += '\\"'; // escapar comilla interna
          }
          i++; continue;
        }
        if (ch === "\n" || ch === "\r" || ch === "\t") { result += " "; i++; continue; }
        result += ch;
      } else {
        if (ch === '"') inString = true;
        result += ch;
      }
      i++;
    }
    return result;
  };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Intento 2: limpiar y reintentar
    try {
      parsed = JSON.parse(cleanJson(raw));
    } catch {
      // Intento 3: extraer solo hasta el último } válido
      let depth = 0; let lastValid = -1;
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        if (raw[i] === "}") { depth--; if (depth === 0) { lastValid = i; break; } }
      }
      if (lastValid === -1) throw new Error("JSON inválido en la respuesta del modelo");
      parsed = JSON.parse(cleanJson(raw.slice(0, lastValid + 1)));
    }
  }
  return parsed;
};

// ── Normalizacion al formato que la UI pinta tal cual ─────────────────
// Muta parsed. OBLIGATORIA antes de guardar en cache: el cache-hit hace
// setData(cached) directo, sin volver a pasar por aqui.
export const normalizarAnalisis = (parsed) => {
  // Normalizar factores: si es objeto {forma_local:70,...} → convertir a array para el UI
  if (parsed.factores && !Array.isArray(parsed.factores)) {
    const f = parsed.factores;
    parsed.factores = [
      { nombre: "Forma", icono: "📈", local: f.forma_local || 50, visitante: f.forma_visitante || 50, detalle: "" },
      { nombre: "Presión", icono: "🏟️", local: f.presion_local || 50, visitante: f.presion_visitante || f.presion_local || 50, detalle: "" },
      { nombre: "Motivación", icono: "🎯", local: f.motivacion_local || 50, visitante: f.motivacion_visitante || 50, detalle: "" },
      { nombre: "Cansancio", icono: "😴", local: 100-(f.cansancio_local||25), visitante: 100-(f.cansancio_visitante||25), detalle: "" },
    ];
  }
  if (!parsed.factores) parsed.factores = [];

  // Normalizar bajas: si son strings → convertir a arrays de objetos
  if (parsed.bajas) {
    const toArr = (v) => {
      if (Array.isArray(v)) return v;
      if (!v || typeof v !== "string") return [];
      const s = v.trim();
      if (!s || s.toLowerCase() === "ninguna" || s === "-" || s === "sin bajas") return [];
      return s.split(",").map(n => ({ nombre: n.trim(), posicion: "N/D", es_titular: false }));
    };
    parsed.bajas.local = toArr(parsed.bajas.local);
    parsed.bajas.visitante = toArr(parsed.bajas.visitante);
  } else {
    parsed.bajas = { local: [], visitante: [] };
  }
  return parsed;
};

// Version del recetario (roadmap 1d): sube cuando cambia la receta del
// JSON. Historia: 2 = tabla_cabecera (3-sep), 3 = altitud (5-sep). Los
// analisis viejos conservan la suya y no se migran.
export const RECETA_VERSION = 3;

// ── Linea fija de tabla en la cabecera (Recetario v2a) ────────────────
// Determinista desde el payload de football.js (posicion_local/visitante
// y tabla), jamas del texto de la IA. Muta analisis. Regla: tabla_cabecera
// solo se añade si AMBOS equipos traen posicion y puntos; si falta
// cualquiera (etapa no identificada, eliminatorias, dato incompleto) el
// campo NO existe — silencio honesto, sin placeholder ni texto de relleno.
// receta (RECETA_VERSION) va SIEMPRE, con o sin tabla.
export const adjuntarTabla = (analisis, f) => {
  analisis.receta = RECETA_VERSION;
  // Defensa: si el modelo llegara a inventar una tabla_cabecera propia,
  // aqui muere — la unica que existe es la determinista de abajo.
  delete analisis.tabla_cabecera;
  const l = f?.posicion_local;
  const v = f?.posicion_visitante;
  if (l?.pos == null || l?.pts == null || v?.pos == null || v?.pts == null) return analisis;
  analisis.tabla_cabecera = {
    texto: f.tabla,
    local: { pos: l.pos, pts: l.pts },
    visitante: { pos: v.pos, pts: v.pts },
  };
  return analisis;
};

// ── Linea de altitud en la cabecera (Recetario v2b, receta 3) ─────────
// Determinista desde f.altitud (football.js, seccion 7b), jamas del texto
// de la IA. Muta analisis. Sin altitud del partido, el campo NO existe.
// Umbrales de banda por la altitud del PARTIDO, en metros: el efecto
// fisiologico arranca ~1500 y se dispara ~2500 (La Paz 3600, Quito 2850,
// Bogota 2600). La banda "ruido" existe en el JSON pero NO se pinta.
const ALTITUD_FUERTE_M = 2500;
const ALTITUD_MODERADA_M = 1500;
export const adjuntarAltitud = (analisis, f) => {
  // Defensa: si el modelo llegara a inventar una altitud_info propia,
  // aqui muere — la unica que existe es la determinista de abajo.
  delete analisis.altitud_info;
  const a = f?.altitud;
  if (a?.partido_m == null) return analisis;
  const info = {
    partido_m: a.partido_m,
    visitante_origen_m: a.visitante_origen_m ?? null,
    banda:
      a.partido_m >= ALTITUD_FUERTE_M ? "fuerte"
      : a.partido_m >= ALTITUD_MODERADA_M ? "moderada"
      : "ruido",
  };
  if (a.visitante_origen_m != null) info.delta_visitante_m = a.partido_m - a.visitante_origen_m;
  analisis.altitud_info = info;
  return analisis;
};

// ── Posts para compartir ──────────────────────────────────────────────
// Muta parsed (post_telegram/post_whatsapp) y devuelve { bL, bV, pr },
// que el cliente reutiliza para el snapshot del historial.
export const adjuntarPosts = (parsed) => {
  const t1 = parsed.mercados_analizados?.find(m => m.ranking === 1) || parsed.top_apuesta || {};
  const t2 = parsed.mercados_analizados?.find(m => m.ranking === 2) || {};
  const t3 = parsed.mercados_analizados?.find(m => m.ranking === 3) || {};
  const bL = parsed.bajas?.local?.map(b => `${b.nombre} (${b.posicion})`).join(", ") || "Sin bajas confirmadas";
  const bV = parsed.bajas?.visitante?.map(b => `${b.nombre} (${b.posicion})`).join(", ") || "Sin bajas confirmadas";
  const pr = parsed.probabilidades_1x2 || parsed.probabilidades || {};
  const cuota1 = (t1.cuota || parsed.top_apuesta?.cuota || 0).toFixed(2);
  const conf1 = t1.nivel_confianza || parsed.top_apuesta?.nivel_confianza || "—";
  const ev1 = ((t1.ev || 0) * 100).toFixed(1);
  const nombre1 = t1.nombre || parsed.top_apuesta?.mercado || "—";
  const desc1 = t1.descripcion || parsed.top_apuesta?.descripcion || "—";
  const fuente1 = t1.cuota_fuente || parsed.top_apuesta?.cuota_fuente || "Estimada";

  parsed.post_telegram = `🏆 *BetFut* — ANÁLISIS ÉLITE\n\n⚽ ${parsed.partido?.local} vs ${parsed.partido?.visitante}\n🏆 ${parsed.partido?.competicion || "Fútbol"} | ${parsed.partido?.fecha || "Próximos días"}\n\n━━━━━━━━━━━━━━━━━━━━\n🥇 APUESTA #1 — MAYOR VALOR\n━━━━━━━━━━━━━━━━━━━━\n🎯 ${nombre1}: ${desc1}\n💰 Cuota: ${cuota1} (${fuente1})\n📊 Confianza: ${conf1}% | EV: +${ev1}%\n\n🥈 ALTERNATIVA #2\n🎯 ${t2.nombre || "—"}: ${t2.descripcion || "—"}\n💰 Cuota: ${(t2.cuota || 0).toFixed(2)} | Confianza: ${t2.nivel_confianza || "—"}%\n\n🥉 ALTERNATIVA #3\n🎯 ${t3.nombre || "—"}: ${t3.descripcion || "—"}\n💰 Cuota: ${(t3.cuota || 0).toFixed(2)} | Confianza: ${t3.nivel_confianza || "—"}%\n\n━━━━━━━━━━━━━━━━━━━━\n🔑 PUNTOS CLAVE\n━━━━━━━━━━━━━━━━━━━━\n${(parsed.puntos_clave || []).map(p => `• ${p}`).join("\n")}\n\n🏥 Bajas ${parsed.partido?.local}: ${bL}\n🏥 Bajas ${parsed.partido?.visitante}: ${bV}\n\n⚡ Local ${pr.victoria_local}% | Empate ${pr.empate}% | Visit. ${pr.victoria_visitante}%\n\n⚠️ Solo sugerencia. Juega con responsabilidad.`;

  parsed.post_whatsapp = `🏆 *BetFut*\n\n⚽ *${parsed.partido?.local} vs ${parsed.partido?.visitante}*\n📅 ${parsed.partido?.fecha || "Próximos días"} | 🏆 ${parsed.partido?.competicion || "Fútbol"}\n\n─────────────────────\n🥇 *MEJOR APUESTA*\n─────────────────────\n🎯 *${nombre1}*\n📝 ${desc1}\n💰 Cuota: *${cuota1}* (${fuente1})\n✅ Confianza: *${conf1}%* | EV: *+${ev1}%*\n\n─────────────────────\n🥈 *ALTERNATIVAS*\n─────────────────────\n🎯 ${t2.nombre || "—"} — Cuota *${(t2.cuota || 0).toFixed(2)}*\n🎯 ${t3.nombre || "—"} — Cuota *${(t3.cuota || 0).toFixed(2)}*\n\n─────────────────────\n🔑 *PUNTOS CLAVE*\n─────────────────────\n${(parsed.puntos_clave || []).map((p, i) => `${i + 1}️⃣ ${p}`).join("\n")}\n\n🏥 *Bajas:*\n▪️ ${parsed.partido?.local}: ${bL}\n▪️ ${parsed.partido?.visitante}: ${bV}\n\n📊 Local ${pr.victoria_local}% | Empate ${pr.empate}% | Visit. ${pr.victoria_visitante}%\n\n_⚠️ Solo sugerencia. Juega responsable._`;

  return { bL, bV, pr };
};
