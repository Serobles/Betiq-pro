#!/usr/bin/env node
// ── El cocinero: pre-generador de analisis (cron, paso 3) ─────────────
// Recorre las ligas del producto, selecciona los partidos con kickoff en
// las proximas 32h y decide cuales generar. CERO copias de logica: las
// ligas salen de api/_ligas.js, el pipeline de datos de api/football.js
// y el prompt/parseo/normalizacion/posts de api/_analysis.js.
//
// Modo ensayo (--dry-run): decide e imprime la tabla, sin llamar a
// Claude y sin escribir la despensa. La lectura del cache usa la anon
// key (la politica de lectura es publica); el modo real exigira
// service_role.
//
// Uso:
//   node scripts/cocinero.mjs --dry-run [--max=60] [--fixture=ID]   ensayo
//   node scripts/cocinero.mjs [--max=60] [--fixture=ID]             REAL
//   node scripts/cocinero.mjs --sonda                               sonda de cuotas
//     (72h, solo lectura del mercado: sin Claude, sin despensa, sin
//      cuaderno; ignora --dry-run, --max y --fixture; solo pide
//      API_FOOTBALL_KEY)
//   node scripts/cocinero.mjs --sonda-arbitros                      sonda de arbitros (v2c, paso 0)
//     (disponibilidad de fixture.referee: futuros a 72h por bucket +
//      historico de 30 dias con nombres distintos y literales crudos;
//      solo lectura; ignora --dry-run, --max y --fixture; solo pide
//      API_FOOTBALL_KEY)
//   node scripts/cocinero.mjs --sonda-plazas                        sonda de plazas (atlas, fase 2)
//     (censo de venues usados por los fixtures de la temporada COMPLETA
//      contra la tabla estadios: huerfanos ordenados por uso, % de
//      fixtures con venue null por liga; LEE estadios pero no escribe
//      nada; ignora --dry-run, --max y --fixture; exige API_FOOTBALL_KEY
//      + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//   node scripts/cocinero.mjs --sembrar-arbitros                    sembrador de arbitros (v2c)
//     (backfill de arbitro_partidos por temporada: fixtures jugados con
//      referee → tarjetas (1 peticion/fixture) → upsert. TROCEADO y
//      REANUDABLE: hasta 600 fixtures nuevos por corrida — correrlo
//      varias veces hasta vaciar. Ignora --dry-run, --max y --fixture;
//      exige API_FOOTBALL_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//   node scripts/cocinero.mjs --sembrar-estadios                    sembrador (v2b)
//     (/teams de las 17 ligas → tablas estadios y equipos_estadio;
//      JAMAS toca altitud_m; ignora --dry-run, --max y --fixture; exige
//      API_FOOTBALL_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
//      Si va junto a --sonda, gana la sonda y este se ignora con aviso.)
//
// Env en ensayo: API_FOOTBALL_KEY (siempre); SUPABASE_URL + una clave
// (anon o service) para el filtro de despensa — si faltan, despensa
// vacia con aviso.
// Env en modo REAL (falla al arrancar si falta alguno): API_FOOTBALL_KEY,
// ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. La service
// key acepta LOS DOS formatos del panel: la legacy tipo JWT (eyJ..., rol
// service_role) y la nueva secret key (sb_secret_...).

import { LIGAS } from "../api/_ligas.js";
import { obtenerDatosFixture } from "../api/football.js";
import {
  SYSTEM_PROMPT,
  construirSearchData,
  construirMensajeUsuario,
  parsearRespuestaAnalisis,
  normalizarAnalisis,
  ordenarMercados,
  adjuntarTabla,
  adjuntarAltitud,
  adjuntarPosts,
  normalizarArbitro,
} from "../api/_analysis.js";

// ── Flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SONDA = args.includes("--sonda");
// Precedencia entre casillas: --sonda > --sonda-arbitros >
// --sonda-plazas > --sembrar-arbitros > --sembrar-estadios. Entre modos
// de solo lectura gana el mas antiguo; cualquier sonda gana a los que
// escriben, y entre sembradores gana el de arbitros — el modo que
// escribe nunca se activa por descuido de marcar dos casillas. El
// ignorado avisa.
const SONDA_ARBITROS = !SONDA && args.includes("--sonda-arbitros");
const SONDA_PLAZAS = !SONDA && !SONDA_ARBITROS && args.includes("--sonda-plazas");
const SEMBRAR_ARBITROS = !SONDA && !SONDA_ARBITROS && !SONDA_PLAZAS && args.includes("--sembrar-arbitros");
const SEMBRAR = !SONDA && !SONDA_ARBITROS && !SONDA_PLAZAS && !SEMBRAR_ARBITROS && args.includes("--sembrar-estadios");
// El || 60 no es adorno: en las corridas por schedule los inputs del
// workflow llegan vacios y "--max=" parsearia a 0 — cero generaciones.
const MAX = Number((args.find(a => a.startsWith("--max=")) || "--max=60").slice(6)) || 60;
// La sonda tambien ignora --fixture: mide el mercado completo, nunca un
// partido suelto (la rama SOLO_FIXTURE ademas etiqueta la liga con otro
// formato y descuadraria las tablas).
const SOLO_FIXTURE = SONDA ? null : Number((args.find(a => a.startsWith("--fixture=")) || "").slice(10)) || null;
const DISPARADOR = (args.find(a => a.startsWith("--disparador=")) || "--disparador=local").slice(13);

// Primera linea SIEMPRE: el modo resuelto, el tope y quien disparo — para
// que el registro de una corrida nunca deje dudas de que se ejecuto.
// Las sondas y el sembrador ignoran --dry-run, --max y --fixture.
if (SONDA) console.log(`SONDA: solo lectura del mercado | ventana=72h | disparador=${DISPARADOR}`);
else if (SONDA_ARBITROS) console.log(`SONDA ARBITROS: disponibilidad de referee | futuros 72h + histórico 30d | disparador=${DISPARADOR}`);
else if (SONDA_PLAZAS) console.log(`SONDA PLAZAS: venues de fixtures vs atlas | temporada completa | disparador=${DISPARADOR}`);
else if (SEMBRAR_ARBITROS) console.log(`SEMBRADOR DE ARBITROS: backfill de tarjetas por temporada | tope=600 | disparador=${DISPARADOR}`);
else if (SEMBRAR) console.log(`SEMBRADOR DE ESTADIOS: /teams de las ligas → estadios + equipos_estadio | disparador=${DISPARADOR}`);
else console.log(`COCINERO — modo=${DRY ? "ENSAYO" : "REAL"} | max=${MAX} | disparador=${DISPARADOR}`);
const sondaActiva = SONDA ? "la sonda de cuotas" : SONDA_ARBITROS ? "la sonda de arbitros" : SONDA_PLAZAS ? "la sonda de plazas" : null;
if (SONDA && args.includes("--sonda-arbitros"))
  console.error("(aviso) --sonda-arbitros ignorado: la sonda de cuotas tiene precedencia");
if ((SONDA || SONDA_ARBITROS) && args.includes("--sonda-plazas"))
  console.error(`(aviso) --sonda-plazas ignorado: ${SONDA ? "la sonda de cuotas" : "la sonda de arbitros"} tiene precedencia`);
if (sondaActiva && args.includes("--sembrar-arbitros"))
  console.error(`(aviso) --sembrar-arbitros ignorado: ${sondaActiva} (solo lectura) tiene precedencia`);
if ((sondaActiva || SEMBRAR_ARBITROS) && args.includes("--sembrar-estadios"))
  console.error(`(aviso) --sembrar-estadios ignorado: ${sondaActiva ? `${sondaActiva} (solo lectura)` : "el sembrador de arbitros"} tiene precedencia`);

// ── Credenciales ──────────────────────────────────────────────────────
const AF_KEY = process.env.API_FOOTBALL_KEY;
if (!AF_KEY) {
  console.error("Falta API_FOOTBALL_KEY en el entorno.");
  process.exit(1);
}
const SUPA_URL = process.env.SUPABASE_URL || "";
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// El modo real gasta dinero: si falta un secreto, se para AQUI con la
// lista completa, no a mitad de corrida. Las sondas de cuotas y arbitros
// no tocan Supabase: basta API_FOOTBALL_KEY. La sonda de plazas LEE
// Supabase y los dos sembradores ademas escriben: exigen la service key
// (contexto del cron en Actions, sin anon key) y validan su formato
// aunque lleven --dry-run, que ignoran. Ninguno de ellos exige Anthropic.
const CON_SUPABASE = SEMBRAR || SEMBRAR_ARBITROS || SONDA_PLAZAS;
if ((!DRY && !SONDA && !SONDA_ARBITROS && !CON_SUPABASE) || CON_SUPABASE) {
  const faltan = [];
  if (!ANTHROPIC_KEY && !CON_SUPABASE) faltan.push("ANTHROPIC_API_KEY");
  if (!SUPA_URL) faltan.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) faltan.push("SUPABASE_SERVICE_ROLE_KEY");
  if (faltan.length) {
    const quien = SEMBRAR ? "Sembrador" : SEMBRAR_ARBITROS ? "Sembrador de arbitros" : SONDA_PLAZAS ? "Sonda de plazas" : "Modo real";
    console.error(`${quien}: faltan secretos en el entorno: ${faltan.join(", ")}`);
    process.exit(1);
  }

  // La service key vale en sus DOS formatos: JWT legacy (rol service_role)
  // o la nueva secret key sb_secret_... Se rechazan con mensaje claro las
  // claves equivocadas del panel (anon / publishable).
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rolJWT = (t) => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64").toString()).role; } catch { return null; } };
  if (sr.startsWith("sb_publishable_")) {
    console.error("SUPABASE_SERVICE_ROLE_KEY es una publishable key (sb_publishable_...): esa es la publica. Copia la SECRET (sb_secret_...) o la service_role legacy (JWT).");
    process.exit(1);
  }
  if (!sr.startsWith("sb_secret_")) {
    const rol = rolJWT(sr);
    if (rol !== "service_role") {
      console.error(`SUPABASE_SERVICE_ROLE_KEY no es valida: ${rol ? `es un JWT con rol "${rol}"` : "no es ni sb_secret_... ni un JWT"}. Copia la service_role (JWT legacy) o la secret key (sb_secret_...).`);
      process.exit(1);
    }
  }
}

// Cabeceras para PostgREST segun el formato de la clave: la sb_secret va
// SOLO en apikey; el JWT legacy va en apikey y en Authorization.
const cabecerasSupa = (clave) =>
  clave.startsWith("sb_secret_")
    ? { apikey: clave }
    : { apikey: clave, Authorization: `Bearer ${clave}` };

// ── Utiles ────────────────────────────────────────────────────────────
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Mismo patron medido del resto de la app: la API corta rafagas de mas
// de 4 peticiones simultaneas aunque sobre cuota.
const TANDA = 4;
// 1s entre tandas de 4 = ~240 req/min sostenidos: el plan Pro corta a 300/min (sonda del 5-sep: 136 req en ~12s tumbaron 5).
const PAUSA_MS = 1000;
const enTandas = async (items, fn) => {
  const res = [];
  for (let i = 0; i < items.length; i += TANDA) {
    const trozo = items.slice(i, i + TANDA);
    res.push(...await Promise.all(trozo.map((x) => fn(x).catch((e) => ({ __error: e.message })))));
    if (i + TANDA < items.length) await dormir(PAUSA_MS);
  }
  return res;
};

// Peticion a API-Football con la misma deteccion de errores del resto del
// repo: errors llega como [] cuando no hay error (truthy enganoso).
// El contador alimenta el reporte de la sonda (costo real de la corrida).
let peticionesAF = 0;
const af = async (ruta) => {
  peticionesAF++;
  const r = await fetch(`https://v3.football.api-sports.io${ruta}`, {
    headers: { "x-apisports-key": AF_KEY },
  });
  const d = await r.json();
  const e = d?.errors;
  const hay = Array.isArray(e) ? e.length > 0 : Boolean(e && Object.keys(e).length > 0);
  if (hay) throw new Error(Object.entries(e).map(([k, v]) => `${k}: ${v}`).join(" | "));
  return d;
};

// Timestamps de Supabase sin zona: fijarles Z antes de parsear.
const utcMs = (t) => (t ? new Date(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t + "Z").getTime() : NaN);

// ── 1. Season por fechas REALES (el flag current miente: Paraguay 250) ──
// Fallback de FRONTERA: si ninguna season contiene hoy, vale la de end
// mas reciente dentro de la tolerancia — puentea los huecos entre etapas
// (Apertura→Clausura) y la frontera de enero mientras la API carga las
// fechas nuevas. Caso medido 8-sep-2026: Venezuela con end vencido el
// 7-sep y fixtures aun activos bajo esa misma season. Mas alla de la
// tolerancia sigue irresoluble: temporada realmente terminada. El
// fallback se anuncia en el log — la excepcion se ve, no se camufla.
const TOLERANCIA_FRONTERA_DIAS = 21;
const hoyISO = new Date().toISOString().slice(0, 10);
const resolverSeason = async (ligaId) => {
  const d = await af(`/leagues?id=${ligaId}`);
  const seasons = d.response?.[0]?.seasons || [];
  const s = seasons.find((x) => x.start <= hoyISO && hoyISO <= x.end);
  if (s) return s.year;
  const limite = new Date(Date.now() - TOLERANCIA_FRONTERA_DIAS * 86400000).toISOString().slice(0, 10);
  const reciente = seasons
    .filter((x) => x.end && x.end < hoyISO && x.end >= limite)
    .sort((a, b) => (a.end < b.end ? 1 : -1))[0];
  if (reciente) {
    const nombre = LIGAS.find((l) => l.id === ligaId)?.nombre || `liga ${ligaId}`;
    console.log(`(fallback frontera) ${nombre}: season ${reciente.year}, end vencido ${reciente.end}`);
    return reciente.year;
  }
  return null;
};

// ── 2. Seleccion: NS con kickoff en [ahora, ahora+ventana], en UTC ────
// El cocinero va en 32h (hastaS); la sonda pide 72h por parametro.
const ahoraS = Math.floor(Date.now() / 1000);
// 32h porque la promesa es despensa 24h antes del kickoff y las corridas van cada ~6-8h (retraso del schedule incluido): peor caso ~24h. Respaldo: sonda 3-sep-2026 (Europa 100% con cuotas a 24-72h; Sudamerica ~89-91%).
const hastaS = ahoraS + 32 * 3600;
const hastaSondaS = ahoraS + 72 * 3600;

// Ligas que la seleccion perdio (season irresoluble o fixtures caidos).
// La sonda de cuotas las lista en su reporte, y el cocinero las imprime
// como OJO antes de TOTALES — solo aviso, SIN exit 1: una corrida del
// cron no debe pintarse de crash por una liga caida; la siguiente
// reintenta. (En las sondas si hay exit 1: alli la completitud es el
// producto.)
const ligasSinDatos = [];

const seleccionar = async (limiteS = hastaS) => {
  const desdeFecha = new Date(ahoraS * 1000).toISOString().slice(0, 10);
  const hastaFecha = new Date(limiteS * 1000).toISOString().slice(0, 10);
  if (SOLO_FIXTURE) {
    const d = await af(`/fixtures?id=${SOLO_FIXTURE}`);
    const f = d.response?.[0];
    if (!f) { console.error(`El fixture ${SOLO_FIXTURE} no existe.`); process.exit(1); }
    return [{ f, liga: `${f.league?.name} (${f.league?.id})` }];
  }

  // season por liga, en tandas
  ligasSinDatos.length = 0;
  const seasons = await enTandas(LIGAS, async (l) => ({ id: l.id, season: await resolverSeason(l.id) }));
  LIGAS.forEach((l, i) => {
    if (seasons[i]?.season == null)
      ligasSinDatos.push(`${l.nombre} — ${seasons[i]?.__error ? `season: ${seasons[i].__error}` : "sin season vigente"}`);
  });
  const conSeason = LIGAS.map((l, i) => ({ ...l, season: seasons[i]?.season }))
    .filter((l) => l.season != null);

  // fixtures por liga (from/to filtran por DIA de calendario, no por hora:
  // el corte real es fixture.timestamp, unix e inmune a zonas y DST)
  const porLiga = await enTandas(conSeason, async (l) => {
    const d = await af(`/fixtures?league=${l.id}&season=${l.season}&from=${desdeFecha}&to=${hastaFecha}&timezone=UTC`);
    return (d.response || []).map((f) => ({ f, liga: l.nombre }));
  });
  porLiga.forEach((x, i) => {
    if (x?.__error) ligasSinDatos.push(`${conSeason[i].nombre} — fixtures: ${x.__error}`);
  });

  return porLiga.flat().filter((x) => x && !x.__error);
};

// ── 3. Despensa: que hay cacheado y vigente ───────────────────────────
const leerDespensa = async (ids) => {
  if (!SUPA_URL || !SUPA_KEY) {
    console.error("(aviso) sin SUPABASE_URL/clave: se asume despensa vacia en el ensayo\n");
    return new Map();
  }
  if (!ids.length) return new Map();
  // La despensa es lectura OBLIGATORIA en modo real: si no responde, casi
  // seguro tampoco se podra guardar (Supabase pausado, DNS, clave mala) y
  // generar sin poder guardar es dinero al vacio varias veces al dia. Se
  // reintenta 3 veces con pausa y, si sigue muda, se ABORTA con exit 1 y
  // CERO llamadas a Claude — el fallback en vivo cubre a los usuarios.
  // En ensayo (sin gasto posible) se avisa y se asume vacia, como en 3a.
  for (let intento = 1; ; intento++) {
    try {
      const r = await fetch(
        `${SUPA_URL}/rest/v1/analysis_cache?select=fixture_id,expires_at&fixture_id=in.(${ids.join(",")})`,
        { headers: cabecerasSupa(SUPA_KEY) }
      );
      const filas = await r.json();
      if (!Array.isArray(filas)) throw new Error(JSON.stringify(filas).slice(0, 120));
      return new Map(filas.map((x) => [x.fixture_id, x.expires_at]));
    } catch (e) {
      if (intento < 3) {
        console.error(`(despensa: intento ${intento}/3 fallo — ${e.message.slice(0, 100)}) reintentando...`);
        await dormir(2000);
        continue;
      }
      if (DRY) {
        console.error(`(aviso) despensa ilegible tras 3 intentos: se asume vacia en el ensayo
`);
        return new Map();
      }
      console.error(`Despensa inalcanzable tras 3 intentos (${e.message.slice(0, 120)}).`);
      console.error(`Se aborta SIN llamar a Claude: si no se puede leer, casi seguro tampoco se puede guardar.`);
      process.exit(1);
    }
  }
};

// ── 4. Cuotas reales: Bet365 (8) o Betano (32) con mercados ───────────
const tieneCuotas = async (fixtureId) => {
  const d = await af(`/odds?fixture=${fixtureId}`);
  const casas = d.response?.[0]?.bookmakers || [];
  return casas.some((b) => (b.id === 8 || b.id === 32) && (b.bets || []).length > 0);
};

// ── Sonda de cuotas: mide el mercado a 72h, sin cocinar ───────────────
// Solo lectura de API-Football: cero Claude, cero despensa, cero
// cuaderno. Responde a "¿a cuantas horas del kickoff cuelgan linea
// Bet365/Betano por region?" para dimensionar la ventana del cocinero
// sin pagar generaciones por averiguarlo.
if (SONDA) {
  const EUROPA = new Set([39, 140, 135, 78, 61]); // las 5 grandes de api/_ligas.js
  const region = (f) => (EUROPA.has(f.league?.id) ? "Europa" : "Sudamerica");
  const BUCKETS = ["0-24h", "24-48h", "48-72h"];
  // ts <= hastaSondaS garantiza <= 72h; el clamp cubre el borde exacto.
  const bucketDe = (ts) => BUCKETS[Math.min(2, Math.floor((ts - ahoraS) / 86400))];

  const candidatos = await seleccionar(hastaSondaS);
  const vivos = candidatos.filter(({ f }) => {
    const ts = f.fixture?.timestamp || 0;
    return f.fixture?.status?.short === "NS" && ts >= ahoraS && ts <= hastaSondaS;
  });

  const cuotas = await enTandas(vivos, ({ f }) => tieneCuotas(f.fixture.id));
  const medidos = vivos.map((x, i) => {
    const c = cuotas[i];
    return { liga: x.liga, con: c === true, err: Boolean(c && c.__error), bucket: bucketDe(x.f.fixture.timestamp), region: region(x.f) };
  });
  const errores = medidos.filter((x) => x.err).length;

  // Un chequeo caido NO es "sin cuotas": se saca del denominador y se
  // anota en la celda (+Nerr) — un % desinflado por errores dirigiria mal
  // la decision de ventana, que es justo lo que la sonda alimenta.
  const celda = (xs) => {
    if (!xs.length) return "—";
    const err = xs.filter((x) => x.err).length;
    const ok = xs.length - err;
    const con = xs.filter((x) => x.con).length;
    const pct = ok ? `${con}/${ok} (${Math.round((con / ok) * 100)}%)` : "s/d";
    return err ? `${pct} +${err}err` : pct;
  };
  const ancho = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
  const tabla = (titulo, grupos) => {
    console.log(`\n${titulo}`);
    console.log(`${ancho("", 32)} ${BUCKETS.map((b) => ancho(b, 18)).join(" ")} ${ancho("total", 18)}`);
    console.log("─".repeat(110));
    for (const [nombre, xs] of grupos) {
      const porBucket = BUCKETS.map((b) => ancho(celda(xs.filter((x) => x.bucket === b)), 18));
      console.log(`${ancho(nombre, 32)} ${porBucket.join(" ")} ${ancho(celda(xs), 18)}`);
    }
  };

  console.log(`\nSONDA — ventana UTC ${new Date(ahoraS * 1000).toISOString().slice(0, 16)}Z → ${new Date(hastaSondaS * 1000).toISOString().slice(0, 16)}Z | fixtures NS=${vivos.length}`);
  tabla("Por region (con cuotas / total):", [
    ["Europa", medidos.filter((x) => x.region === "Europa")],
    ["Sudamerica", medidos.filter((x) => x.region === "Sudamerica")],
  ]);
  // Desglose en el orden del producto; una liga sin partidos en ventana
  // pinta "—" en vez de desaparecer. Y "—" no puede esconder un fallo:
  // las ligas que la seleccion perdio se listan aparte, abajo.
  tabla("Por liga (con cuotas / total):",
    LIGAS.map((l) => [l.nombre, medidos.filter((x) => x.liga === l.nombre)])
  );
  if (ligasSinDatos.length) {
    console.log(`\nOJO — ligas sin datos en esta corrida (sus "—" no significan "sin partidos"):`);
    for (const l of ligasSinDatos) console.log(`  - ${l}`);
  }
  console.log(`\nPeticiones a API-Football usadas: ${peticionesAF}${errores ? ` | chequeos de cuotas con error (excluidos del %): ${errores}` : ""}`);
  process.exit(0);
}

// ── Sonda de arbitros (Recetario v2c, paso 0): ¿el dato existe? ───────
// Mide la disponibilidad REAL de fixture.referee antes de diseñar la
// tabla arbitros: futuros a 72h (¿cuando se confirma el nombre?) e
// historico de 30 dias (¿cuan poblado viene y cuantos nombres distintos?).
// Solo lectura de API-Football: cero Claude, cero escrituras, cero
// cuaderno. Los literales se imprimen crudos (JSON.stringify) para
// diseñar la normalizacion del texto libre con ejemplos reales.
if (SONDA_ARBITROS) {
  const BUCKETS = ["0-24h", "24-48h", "48-72h"];
  const bucketDe = (ts) => BUCKETS[Math.min(2, Math.floor((ts - ahoraS) / 86400))];
  const JUGADO = new Set(["FT", "AET", "PEN"]);
  const conReferee = (f) => typeof f.fixture?.referee === "string" && f.fixture.referee.trim() !== "";

  const ligasCaidas = [];
  const seasons = await enTandas(LIGAS, async (l) => ({ id: l.id, season: await resolverSeason(l.id) }));
  const conSeason = [];
  LIGAS.forEach((l, i) => {
    if (seasons[i]?.season != null) conSeason.push({ ...l, season: seasons[i].season });
    else {
      console.error(`(aviso) ${l.nombre}: season irresoluble${seasons[i]?.__error ? ` (${seasons[i].__error})` : ""} — liga omitida`);
      ligasCaidas.push(`${l.nombre} — season irresoluble`);
    }
  });

  const fechaDe = (s) => new Date(s * 1000).toISOString().slice(0, 10);
  const hoy = fechaDe(ahoraS);
  const pedirVentana = (l, desde, hasta) =>
    af(`/fixtures?league=${l.id}&season=${l.season}&from=${desde}&to=${hasta}&timezone=UTC`)
      .then((d) => d.response || []);

  const futuros = await enTandas(conSeason, (l) => pedirVentana(l, hoy, fechaDe(hastaSondaS)));
  const historico = await enTandas(conSeason, (l) => pedirVentana(l, fechaDe(ahoraS - 30 * 86400), hoy));

  // (a) Futuros: NS por timestamp, liga x bucket "con referee / total (%)"
  const filasNS = [];
  futuros.forEach((lote, i) => {
    const liga = conSeason[i];
    if (!lote || lote.__error) {
      ligasCaidas.push(`${liga.nombre} — futuros: ${lote?.__error || "sin respuesta"}`);
      return;
    }
    for (const f of lote) {
      const ts = f.fixture?.timestamp || 0;
      if (f.fixture?.status?.short !== "NS" || ts < ahoraS || ts > hastaSondaS) continue;
      filasNS.push({ liga: liga.nombre, bucket: bucketDe(ts), con: conReferee(f) });
    }
  });

  const ancho = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
  const celda = (xs) => {
    if (!xs.length) return "—";
    const con = xs.filter((x) => x.con).length;
    return `${con}/${xs.length} (${Math.round((con / xs.length) * 100)}%)`;
  };
  console.log(`\nFuturos a 72h — fixtures NS con referee poblado:`);
  console.log(`${ancho("", 30)} ${BUCKETS.map((b) => ancho(b, 18)).join(" ")} ${ancho("total", 18)}`);
  console.log("─".repeat(108));
  for (const l of conSeason) {
    const xs = filasNS.filter((x) => x.liga === l.nombre);
    const porBucket = BUCKETS.map((b) => ancho(celda(xs.filter((x) => x.bucket === b)), 18));
    console.log(`${ancho(l.nombre, 30)} ${porBucket.join(" ")} ${ancho(celda(xs), 18)}`);
  }

  // (b) Historico 30d: % poblado + nombres distintos (solo trim, sin
  // normalizar — el conteo dimensiona la futura tabla arbitros).
  // (c) De paso se guardan hasta 3 literales CRUDOS por liga (sin trim:
  // JSON.stringify delata espacios, comas y acentos tal como llegan).
  console.log(`\nHistorico 30 dias (${fechaDe(ahoraS - 30 * 86400)} → ${hoy}) — partidos jugados (FT/AET/PEN):`);
  console.log(`${ancho("", 30)} ${ancho("jugados", 8)} ${ancho("con referee", 18)} nombres distintos`);
  console.log("─".repeat(80));
  const muestras = new Map();
  historico.forEach((lote, i) => {
    const liga = conSeason[i];
    if (!lote || lote.__error) {
      ligasCaidas.push(`${liga.nombre} — historico: ${lote?.__error || "sin respuesta"}`);
      console.log(`${ancho(liga.nombre, 30)} ${ancho("error", 8)} ${ancho("—", 18)} —`);
      return;
    }
    const jugados = lote.filter((f) => JUGADO.has(f.fixture?.status?.short));
    const nombres = new Set(jugados.filter(conReferee).map((f) => f.fixture.referee.trim()));
    const crudos = [];
    for (const f of jugados) {
      const r = f.fixture?.referee;
      if (typeof r === "string" && r.trim() && !crudos.includes(r)) {
        crudos.push(r);
        if (crudos.length === 3) break;
      }
    }
    muestras.set(liga.nombre, crudos);
    console.log(`${ancho(liga.nombre, 30)} ${ancho(jugados.length, 8)} ${ancho(celda(jugados.map((f) => ({ con: conReferee(f) }))), 18)} ${nombres.size}`);
  });

  console.log(`\nMuestra de literales crudos de referee (hasta 3 por liga, tal como llegan):`);
  for (const [liga, vals] of muestras) {
    if (!vals.length) continue;
    console.log(`  ${liga}:`);
    for (const v of vals) console.log(`    ${JSON.stringify(v)}`);
  }

  if (ligasCaidas.length) {
    console.log(`\nOJO — ligas sin datos en esta corrida (sus filas no significan "sin arbitros"):`);
    for (const l of ligasCaidas) console.log(`  - ${l}`);
  }
  console.log(`\nPeticiones a API-Football usadas: ${peticionesAF}`);
  // Patron del sembrador: check verde solo con las 17 ligas medidas.
  process.exit(ligasCaidas.length ? 1 : 0);
}

// ── Sonda de plazas (atlas, fase 2): venues usados vs tabla estadios ──
// Censa TODOS los fixtures de la temporada (jugados y futuros, sin
// from/to) y cruza sus venue_id contra el atlas: los huerfanos ordenados
// por uso son la lista de trabajo para completar la tabla — sedes
// neutrales, estadios prestados y plazas que /teams no trae. Solo
// lectura: cero Claude, cero escrituras, cero cuaderno.
if (SONDA_PLAZAS) {
  const ligasCaidas = [];
  const seasons = await enTandas(LIGAS, async (l) => ({ id: l.id, season: await resolverSeason(l.id) }));
  const conSeason = [];
  LIGAS.forEach((l, i) => {
    if (seasons[i]?.season != null) conSeason.push({ ...l, season: seasons[i].season });
    else {
      console.error(`(aviso) ${l.nombre}: season irresoluble${seasons[i]?.__error ? ` (${seasons[i].__error})` : ""} — liga omitida`);
      ligasCaidas.push(`${l.nombre} — season irresoluble`);
    }
  });

  const porLiga = await enTandas(conSeason, async (l) => {
    const d = await af(`/fixtures?league=${l.id}&season=${l.season}&timezone=UTC`);
    return { filas: d.response || [], paginas: d.paging?.total ?? 1 };
  });

  // El atlas actual, solo venue_id, en una lectura. Sin atlas no hay
  // censo: se aborta con el motivo entero (mismo criterio que la
  // despensa del cocinero — si la tabla no responde, el reporte seria
  // mentira: TODO pareceria huerfano).
  let atlas;
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/estadios?select=venue_id`, {
      headers: { ...cabecerasSupa(SUPA_KEY), Prefer: "count=exact" },
    });
    const filas = await r.json();
    if (!r.ok || !Array.isArray(filas)) throw new Error(JSON.stringify(filas).slice(0, 120));
    // PostgREST recorta EN SILENCIO a ~1000 filas sin Range (HTTP 200 y
    // array valido a medias): si el total declarado no cuadra con lo
    // recibido, cientos de estadios parecerian huerfanos. Hoy el atlas
    // ronda ~350 — el guard es para el dia que crezca.
    const total = Number((r.headers.get("content-range") || "").split("/")[1]);
    if (Number.isFinite(total) && total !== filas.length)
      throw new Error(`atlas truncado: llegaron ${filas.length} de ${total} filas`);
    atlas = new Set(filas.map((x) => x.venue_id));
  } catch (e) {
    console.error(`La tabla estadios no responde (${String(e.message).slice(0, 120)}).`);
    console.error(`Sin atlas no hay censo: todo pareceria huerfano. Se aborta.`);
    process.exit(1);
  }

  const vistos = new Map(); // venue_id → { nombre, ciudad, ligas, total, futuros }
  const statsLiga = [];
  porLiga.forEach((lote, i) => {
    const liga = conSeason[i];
    if (!lote || lote.__error) {
      console.error(`(aviso) ${liga.nombre}: /fixtures fallo${lote?.__error ? ` (${lote.__error})` : ""} — liga omitida`);
      ligasCaidas.push(`${liga.nombre} — fixtures: ${lote?.__error || "sin respuesta"}`);
      statsLiga.push({ liga: liga.nombre, error: true });
      return;
    }
    // Verificado en vivo que /fixtures de temporada completa no pagina
    // (una unica respuesta); si la API cambiara, un censo a medias jamas
    // debe pasar por completo — se anota y la corrida sale en rojo.
    if (lote.paginas > 1)
      ligasCaidas.push(`${liga.nombre} — paginacion no leida (${lote.paginas} paginas: censo parcial)`);
    let sinVenue = 0;
    for (const f of lote.filas) {
      const v = f.fixture?.venue;
      if (v?.id == null) { sinVenue++; continue; }
      if (!vistos.has(v.id)) vistos.set(v.id, { nombre: v.name ?? null, ciudad: v.city ?? null, ligas: new Set(), total: 0, futuros: 0 });
      const e = vistos.get(v.id);
      e.ligas.add(liga.nombre);
      e.total++;
      if ((f.fixture?.timestamp || 0) > ahoraS) e.futuros++;
    }
    statsLiga.push({ liga: liga.nombre, fixtures: lote.filas.length, sinVenue });
  });

  const huerfanos = [...vistos.entries()]
    .filter(([id]) => !atlas.has(id))
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.total - a.total);

  // col() alinea SIN recortar: la lista de trabajo va completa, con
  // nombres enteros — un huerfano truncado seria trabajo manual a ciegas.
  const col = (s, n) => String(s ?? "").padEnd(n);
  console.log(`\nHuerfanos — venues usados por fixtures que NO estan en la tabla estadios (por uso, lista completa):`);
  if (!huerfanos.length) {
    console.log(`  (ninguno: el atlas cubre todos los venues vistos)`);
  } else {
    console.log(`${col("venue_id", 9)} | ${col("nombre", 38)} | ${col("ciudad", 22)} | ${col("fixtures", 17)} | ligas`);
    console.log("─".repeat(120));
    for (const h of huerfanos)
      console.log(`${col(h.id, 9)} | ${col(h.nombre, 38)} | ${col(h.ciudad, 22)} | ${col(`${h.total} (${h.futuros} futuros)`, 17)} | ${[...h.ligas].join(", ")}`);
  }

  console.log(`\nFixtures con venue null por liga (el silencio inevitable):`);
  console.log(`${col("liga", 30)} ${col("fixtures", 9)} sin venue.id`);
  console.log("─".repeat(60));
  for (const s of statsLiga) {
    if (s.error) { console.log(`${col(s.liga, 30)} ${col("error", 9)} —`); continue; }
    const pct = s.fixtures ? Math.round((s.sinVenue / s.fixtures) * 100) : 0;
    console.log(`${col(s.liga, 30)} ${col(s.fixtures, 9)} ${s.sinVenue} (${pct}%)`);
  }

  const enAtlas = [...vistos.keys()].filter((id) => atlas.has(id)).length;
  console.log(`\nRESUMEN: venues vistos=${vistos.size} | en atlas=${enAtlas} | huerfanos=${huerfanos.length} | atlas total=${atlas.size}`);

  if (ligasCaidas.length) {
    console.log(`\nOJO — ligas sin datos en esta corrida (el censo puede estar incompleto):`);
    for (const l of ligasCaidas) console.log(`  - ${l}`);
  }
  console.log(`\nPeticiones a API-Football usadas: ${peticionesAF}`);
  // Patron conocido: check verde solo con las 17 ligas censadas.
  process.exit(ligasCaidas.length ? 1 : 0);
}

// ── Sembrador de ARBITROS (v2c, pieza 1): backfill de tarjetas ────────
// Rellena arbitro_partidos con filas CRUDAS por partido jugado con
// referee — los promedios se calculan al leer, recomputables. TROCEADO Y
// REANUDABLE: cada corrida siembra hasta TOPE fixtures nuevos (1 peticion
// de statistics por fixture) y deja dicho cuanto falta; correrlo desde el
// boton varias veces hasta vaciar. Un fixture caido queda SIN fila y la
// proxima corrida lo reintenta sola; exit 1 solo si una LIGA entera cae.
if (SEMBRAR_ARBITROS) {
  // ~600 statistics + ~35 base por corrida: comodo en la cuota diaria y
  // ~3 minutos al ritmo de tandas. Temporada completa ≈ 2-3 corridas.
  const TOPE_BACKFILL = 600;
  const JUGADO = new Set(["FT", "AET", "PEN"]);
  const ligasCaidas = [];

  const seasons = await enTandas(LIGAS, async (l) => ({ id: l.id, season: await resolverSeason(l.id) }));
  const conSeason = [];
  LIGAS.forEach((l, i) => {
    if (seasons[i]?.season != null) conSeason.push({ ...l, season: seasons[i].season });
    else {
      console.error(`(aviso) ${l.nombre}: season irresoluble${seasons[i]?.__error ? ` (${seasons[i].__error})` : ""} — liga omitida`);
      ligasCaidas.push(`${l.nombre} — season irresoluble`);
    }
  });

  const porLiga = await enTandas(conSeason, async (l) => {
    const d = await af(`/fixtures?league=${l.id}&season=${l.season}&timezone=UTC`);
    return { filas: d.response || [], paginas: d.paging?.total ?? 1 };
  });

  // Lo YA sembrado, paginado por Range: PostgREST corta a 1000 filas la
  // consulta sin rango y esta tabla crecera a miles. Sin saber que hay,
  // no se puede reanudar: se aborta con el motivo entero.
  const sembrados = new Set();
  try {
    for (let desde = 0; ; desde += 1000) {
      const r = await fetch(`${SUPA_URL}/rest/v1/arbitro_partidos?select=fixture_id&order=fixture_id`, {
        headers: { ...cabecerasSupa(SUPA_KEY), Range: `${desde}-${desde + 999}` },
      });
      if (r.status === 416) break; // rango mas alla del final: no hay mas
      const filas = await r.json();
      if (!r.ok || !Array.isArray(filas)) throw new Error(JSON.stringify(filas).slice(0, 120));
      for (const x of filas) sembrados.add(x.fixture_id);
      if (filas.length < 1000) break;
    }
  } catch (e) {
    console.error(`arbitro_partidos no responde (${String(e.message).slice(0, 120)}).`);
    console.error(`Sin saber que hay sembrado no se puede reanudar. Se aborta.`);
    process.exit(1);
  }

  const conReferee = (f) => typeof f.fixture?.referee === "string" && f.fixture.referee.trim() !== "";
  const porLigaCand = [];
  porLiga.forEach((lote, i) => {
    const liga = conSeason[i];
    if (!lote || lote.__error) {
      console.error(`(aviso) ${liga.nombre}: /fixtures fallo${lote?.__error ? ` (${lote.__error})` : ""} — liga omitida`);
      ligasCaidas.push(`${liga.nombre} — fixtures: ${lote?.__error || "sin respuesta"}`);
      return;
    }
    if (lote.paginas > 1)
      ligasCaidas.push(`${liga.nombre} — paginacion no leida (${lote.paginas} paginas: backfill parcial)`);
    const jugables = lote.filas.filter((f) => JUGADO.has(f.fixture?.status?.short) && conReferee(f));
    const nuevos = jugables.filter((f) => !sembrados.has(f.fixture.id));
    porLigaCand.push({ liga, ya: jugables.length - nuevos.length, nuevos });
  });

  // Tope global en orden de LIGAS: las primeras se vacian antes.
  const cola = [];
  for (const c of porLigaCand) {
    c.tomados = c.nuevos.slice(0, Math.max(0, TOPE_BACKFILL - cola.length));
    for (const f of c.tomados) cola.push({ f, liga: c.liga });
  }

  const stats = await enTandas(cola, async ({ f }) => {
    const d = await af(`/fixtures/statistics?fixture=${f.fixture.id}`);
    return { bloques: d.response || [] };
  });

  const filasUpsert = [];
  const caidos = [];
  const okPorLiga = new Map();
  cola.forEach(({ f, liga }, i) => {
    const s = stats[i];
    if (!s || s.__error) {
      caidos.push(`${f.fixture.id} (${liga.nombre})${s?.__error ? `: ${s.__error}` : ""}`);
      return;
    }
    // Tarjetas: suma de ambos equipos; value null cuenta como 0 (asi
    // entrega el cero esta API). Solo si la respuesta NO trae bloques se
    // guarda NULL — "stats no disponibles", fila sembrada sin reintento.
    let amarillas = null, rojas = null;
    if (s.bloques.length) {
      const suma = (tipo) => s.bloques.reduce((acc, eq) => {
        const v = (eq.statistics || []).find((x) => x.type === tipo)?.value;
        return acc + (Number(v) || 0);
      }, 0);
      amarillas = suma("Yellow Cards");
      rojas = suma("Red Cards");
    }
    const n = normalizarArbitro(f.fixture.referee);
    filasUpsert.push({
      fixture_id: f.fixture.id,
      arbitro_clave: n?.clave ?? null,
      arbitro_display: n?.display ?? null,
      liga_id: liga.id,
      fecha: (f.fixture.date || "").slice(0, 10) || null,
      amarillas,
      rojas,
    });
    okPorLiga.set(liga.id, (okPorLiga.get(liga.id) || 0) + 1);
  });

  if (filasUpsert.length) {
    const r = await fetch(`${SUPA_URL}/rest/v1/arbitro_partidos?on_conflict=fixture_id`, {
      method: "POST",
      headers: { ...cabecerasSupa(SUPA_KEY), "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(filasUpsert),
    });
    if (!r.ok) {
      console.error(`Upsert en arbitro_partidos fallo — Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
      process.exit(1);
    }
  }

  console.log("");
  let pendienteGlobal = 0;
  for (const c of porLigaCand) {
    const n = okPorLiga.get(c.liga.id) || 0;
    const faltan = c.nuevos.length - n;
    pendienteGlobal += faltan;
    console.log(`${c.liga.nombre}: ${n} nuevos, ${c.ya} ya sembrados, faltan ${faltan}`);
  }

  if (caidos.length) {
    console.log(`\nFixtures caidos en esta corrida (sin fila: la proxima los reintenta):`);
    for (const c of caidos) console.log(`  - ${c}`);
  }
  if (ligasCaidas.length) {
    console.log(`\nOJO — ligas sin datos en esta corrida (su backfill no avanzo):`);
    for (const l of ligasCaidas) console.log(`  - ${l}`);
  }
  console.log(`\nPENDIENTE GLOBAL al salir: ${pendienteGlobal} fixtures — corre el sembrador de nuevo hasta vaciarlo.`);
  console.log(`Peticiones a API-Football usadas: ${peticionesAF}`);
  // Check verde solo si la corrida AVANZO: liga entera caida = rojo, y
  // tambien habia-trabajo-pero-cero-sembrados (cuota agotada tras los
  // listados: todos los statistics caen y sin esto saldria verde con
  // cero progreso — misma regla que el cocinero con errores sin generar).
  process.exit(ligasCaidas.length || (cola.length && !filasUpsert.length) ? 1 : 0);
}

// ── Sembrador de estadios (Recetario v2b): /teams → Supabase ──────────
// Siembra `estadios` y `equipos_estadio` por ids numericos de API-Football,
// nunca por nombre. JAMAS envia altitud_m: merge-duplicates solo actualiza
// las columnas presentes en el cuerpo, asi que re-sembrar no pisa las
// altitudes cargadas a mano. No toca despensa ni cuaderno. La lectura de
// altitud por el recetario NO va aqui: llegara con receta: 3.
if (SEMBRAR) {
  // seasons por fechas reales, el mismo pipeline del cocinero. Toda liga
  // caida se acumula en ligasCaidas: se restata junto a la lista final y
  // decide el exit code — un sembrado a cero con check verde en Actions
  // seria la mentira perfecta.
  const ligasCaidas = [];
  const seasons = await enTandas(LIGAS, async (l) => ({ id: l.id, season: await resolverSeason(l.id) }));
  const conSeason = [];
  LIGAS.forEach((l, i) => {
    if (seasons[i]?.season != null) conSeason.push({ ...l, season: seasons[i].season });
    else {
      console.error(`(aviso) ${l.nombre}: season irresoluble${seasons[i]?.__error ? ` (${seasons[i].__error})` : ""} — liga omitida`);
      ligasCaidas.push(`${l.nombre} — season irresoluble`);
    }
  });

  const porLiga = await enTandas(conSeason, async (l) => {
    const d = await af(`/teams?league=${l.id}&season=${l.season}`);
    return (d.response || []).map((t) => ({ team: t.team, venue: t.venue }));
  });

  const filasEstadios = new Map(); // venue_id → fila de `estadios`
  const filasEquipos = [];         // filas de `equipos_estadio`
  // Dedup por team_id: el orden de LIGAS pone la liga domestica antes que
  // Libertadores/Sudamericana, asi que liga_id queda el del torneo de casa.
  const equiposVistos = new Set();
  const porVenue = new Map();      // venue_id → equipos (para compartidos)
  const sinVenue = [];
  const statsLiga = [];

  porLiga.forEach((lote, i) => {
    const liga = conSeason[i];
    if (!lote || lote.__error) {
      console.error(`(aviso) ${liga.nombre}: /teams fallo${lote?.__error ? ` (${lote.__error})` : ""} — liga omitida`);
      ligasCaidas.push(`${liga.nombre} — /teams fallo`);
      statsLiga.push({ liga: liga.nombre, error: true });
      return;
    }
    const venues = new Set();
    let omitidos = 0;
    for (const { team, venue } of lote) {
      if (venue?.id == null) { omitidos++; sinVenue.push(`${team?.name ?? "?"} (${liga.nombre})`); continue; }
      venues.add(venue.id);
      if (!filasEstadios.has(venue.id))
        filasEstadios.set(venue.id, { venue_id: venue.id, nombre: venue.name ?? null, ciudad: venue.city ?? null, pais: team?.country ?? null });
      if (!equiposVistos.has(team.id)) {
        equiposVistos.add(team.id);
        filasEquipos.push({ team_id: team.id, equipo: team.name, venue_id: venue.id, liga_id: liga.id });
        if (!porVenue.has(venue.id)) porVenue.set(venue.id, []);
        porVenue.get(venue.id).push(team.name);
      }
    }
    statsLiga.push({ liga: liga.nombre, equipos: lote.length, venues: venues.size, sinVenue: omitidos });
  });

  // Upsert en lote unico por tabla; si Supabase no acepta, se para con el
  // motivo entero — sembrar a medias dejaria un mapa mentiroso.
  const upsert = async (tabla, clave, filas) => {
    if (!filas.length) return;
    const r = await fetch(`${SUPA_URL}/rest/v1/${tabla}?on_conflict=${clave}`, {
      method: "POST",
      headers: { ...cabecerasSupa(SUPA_KEY), "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(filas),
    });
    if (!r.ok) {
      console.error(`Upsert en ${tabla} fallo — Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
      process.exit(1);
    }
  };
  await upsert("estadios", "venue_id", [...filasEstadios.values()]);
  await upsert("equipos_estadio", "team_id", filasEquipos);

  const ancho = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
  console.log(`\nSEMBRADOR — equipos guardados=${filasEquipos.length} | estadios distintos=${filasEstadios.size} | equipos sin venue.id=${sinVenue.length}`);
  console.log(`\n${ancho("liga", 30)} ${ancho("equipos", 8)} ${ancho("estadios", 9)} sin venue.id`);
  console.log("─".repeat(62));
  for (const s of statsLiga)
    console.log(`${ancho(s.liga, 30)} ${ancho(s.error ? "error" : s.equipos, 8)} ${ancho(s.error ? "—" : s.venues, 9)} ${s.error ? "—" : s.sinVenue}`);

  if (sinVenue.length) {
    console.log(`\nEquipos omitidos por venue.id null (silencio honesto: sin fila, sin invento):`);
    for (const e of sinVenue) console.log(`  - ${e}`);
  }

  const compartidos = [...porVenue.entries()].filter(([, eq]) => eq.length > 1);
  if (compartidos.length) {
    console.log(`\nEstadios compartidos (mismo venue_id, varios equipos):`);
    for (const [vid, eq] of compartidos)
      console.log(`  ${vid} | ${filasEstadios.get(vid)?.nombre} | ${eq.join(", ")}`);
  }

  // La lista de trabajo manual: los paises con estadios de altura del
  // roadmap, en tabla limpia para copiar del log y rellenar altitud_m.
  const normPais = (t) => (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const PAISES_ALTURA = new Set(["bolivia", "ecuador", "colombia", "peru", "venezuela", "chile", "argentina"]);
  const lista = [...filasEstadios.values()]
    .filter((e) => PAISES_ALTURA.has(normPais(e.pais)))
    .sort((a, b) => normPais(a.pais).localeCompare(normPais(b.pais)) || normPais(a.nombre).localeCompare(normPais(b.nombre)));
  console.log(`\nLISTA PARA ALTITUDES (${lista.length} estadios; rellenar altitud_m a mano en Supabase):`);
  console.log(`${ancho("venue_id", 9)} | ${ancho("nombre", 42)} | ciudad`);
  let paisActual = "";
  for (const e of lista) {
    if (e.pais !== paisActual) { paisActual = e.pais; console.log(`— ${e.pais} —`); }
    console.log(`${ancho(e.venue_id, 9)} | ${ancho(e.nombre, 42)} | ${e.ciudad ?? ""}`);
  }

  if (ligasCaidas.length) {
    console.log(`\nOJO — ligas SIN SEMBRAR en esta corrida (la lista de altitudes puede estar incompleta):`);
    for (const l of ligasCaidas) console.log(`  - ${l}`);
  }

  console.log(`\nPeticiones a API-Football usadas: ${peticionesAF}`);
  // Check verde solo si se sembraron TODAS las ligas; con cualquiera
  // caida el exit 1 delata la corrida incompleta en Actions.
  process.exit(ligasCaidas.length ? 1 : 0);
}

// ── Decidir ───────────────────────────────────────────────────────────
const candidatos = await seleccionar();
const dentro = candidatos.filter(({ f }) => {
  const ts = f.fixture?.timestamp || 0;
  return ts >= ahoraS && ts <= hastaS;
});

const despensa = await leerDespensa(dentro.map(({ f }) => f.fixture.id));

const filas = [];
let porGenerar = 0;
for (const { f, liga } of dentro) {
  const id = f.fixture.id;
  const kickoff = f.fixture.timestamp;
  const base = {
    liga,
    partido: `${f.teams.home.name} vs ${f.teams.away.name}`,
    kickoff: new Date(kickoff * 1000).toISOString().slice(0, 16) + "Z",
    id,
    kickoffTs: kickoff,
  };

  if (f.fixture.status.short !== "NS") {
    filas.push({ ...base, decision: `salta status ${f.fixture.status.short}` });
    continue;
  }

  // Idempotencia por kickoff: una fila vigente CON el kickoff actual se
  // salta; si el guardado no coincide (reprogramado), se regenera.
  const guardado = despensa.get(id);
  if (guardado != null) {
    if (utcMs(guardado) === kickoff * 1000) {
      filas.push({ ...base, decision: "salta cacheado" });
      continue;
    }
    base.nota = "reprogramado: cache con kickoff viejo";
  }

  filas.push({ ...base, decision: "__cuotas__" });
}

// chequeo de cuotas solo para los que siguen vivos, en tandas
const pendientes = filas.filter((x) => x.decision === "__cuotas__");
const cuotas = await enTandas(pendientes, (x) => tieneCuotas(x.id));
pendientes.forEach((x, i) => {
  const c = cuotas[i];
  if (c && c.__error) x.decision = `error cuotas: ${c.__error}`;
  else if (!c) x.decision = "salta sin cuotas";
  else if (porGenerar >= MAX) x.decision = `fuera de tope (max=${MAX})`;
  else { x.decision = "generar"; porGenerar++; }
});

// ── Tabla ─────────────────────────────────────────────────────────────
console.log(`${DRY ? "ENSAYO" : "COCINERO (modo real)"} — ventana UTC ${new Date(ahoraS * 1000).toISOString().slice(0, 16)}Z → ${new Date(hastaS * 1000).toISOString().slice(0, 16)}Z | max=${MAX}\n`);
const ancho = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(`${ancho("liga", 30)} ${ancho("partido", 42)} ${ancho("kickoff UTC", 17)} decision`);
console.log("─".repeat(110));
for (const x of filas) {
  console.log(`${ancho(x.liga, 30)} ${ancho(x.partido, 42)} ${ancho(x.kickoff, 17)} ${x.decision}${x.nota ? `  [${x.nota}]` : ""}`);
}
const cuenta = (d) => filas.filter((x) => x.decision === d || x.decision.startsWith(d)).length;
console.log("─".repeat(110));
// Mejora ascendida de las sondas (8-sep): las ligas que la seleccion
// perdio se avisan tambien aqui — Venezuela estuvo dias fuera del cron
// sin que ninguna corrida lo dijera. Solo aviso, sin exit 1.
if (ligasSinDatos.length) {
  console.log(`OJO — ligas sin datos en esta corrida (la proxima reintenta):`);
  for (const l of ligasSinDatos) console.log(`  - ${l}`);
  console.log("─".repeat(110));
}
console.log(`TOTALES: ${filas.length} en ventana | generar=${cuenta("generar")} | salta cacheado=${cuenta("salta cacheado")} | salta sin cuotas=${cuenta("salta sin cuotas")} | salta status=${cuenta("salta status")} | fuera de tope=${cuenta("fuera de tope")} | errores=${cuenta("error")}`);
if (DRY) {
  console.log(`(ensayo: sin llamadas a Claude, sin escrituras)`);
} else {
  // ── MODO REAL ───────────────────────────────────────────────────────
  const cola = filas.filter((x) => x.decision === "generar");
  console.log(`\nMODO REAL: ${cola.length} fixtures a generar (Claude max 2 en paralelo)\n`);

  // ── El cuaderno (cron_runs): registra inicio y fin de cada corrida ──
  // Si el cuaderno no responde se AVISA y se sigue cocinando: un cuaderno
  // caido no debe apagar la estufa. (La despensa si aborta: sin ella se
  // generaria sin poder guardar.) El ensayo nunca escribe aqui.
  const cuaderno = async (metodo, ruta, body) => {
    try {
      const r = await fetch(`${SUPA_URL}/rest/v1/${ruta}`, {
        method: metodo,
        headers: {
          ...cabecerasSupa(SUPA_KEY),
          "content-type": "application/json",
          Prefer: metodo === "POST" ? "return=representation" : "return=minimal",
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
      return metodo === "POST" ? (await r.json())[0] : true;
    } catch (e) {
      console.error(`(aviso) cuaderno cron_runs no responde (${e.message.slice(0, 100)}): se sigue cocinando`);
      return null;
    }
  };

  const filaCuaderno = await cuaderno("POST", "cron_runs", {
    modo: "real",
    encontrados: filas.length,
    saltados_cacheados: cuenta("salta cacheado"),
    saltados_sin_cuotas: cuenta("salta sin cuotas"),
    fuera_de_tope: cuenta("fuera de tope"),
  });

  // API-Football en exclusiva mutua: obtenerDatosFixture ya dispara su
  // tanda interna de 4; dos a la vez serian 8 simultaneas y la API corta.
  // Claude si se solapa (hasta 2), que es donde se va el tiempo.
  let turnoAF = Promise.resolve();
  const conAF = (fn) => {
    const p = turnoAF.then(fn);
    turnoAF = p.then(() => {}, () => {});
    return p;
  };

  const llamarClaude = async (contenido) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      // Mismo cuerpo que api/analyze.js: modelo y tope identicos.
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: contenido }],
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${d?.error?.message || ""}`.trim());
    return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  };

  // Cortacircuitos: 3 guardados fallidos CONSECUTIVOS detienen la corrida
  // — si Supabase dejo de aceptar escrituras, cada fixture mas es una
  // llamada a Claude tirada. Un guardado bueno resetea el contador.
  let fallosGuardadoSeguidos = 0;
  let cortocircuito = false;

  const guardar = async (fila, parsed) => {
    // El contrato documentado de la despensa: match_key "fixture:<id>",
    // conflicto por fixture_id, expires_at = kickoff.
    const r = await fetch(`${SUPA_URL}/rest/v1/analysis_cache?on_conflict=fixture_id`, {
      method: "POST",
      headers: {
        ...cabecerasSupa(SUPA_KEY),
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        match_key: `fixture:${fila.id}`,
        fixture_id: fila.id,
        local: parsed?.partido?.local || fila.partido.split(" vs ")[0],
        visitante: parsed?.partido?.visitante || fila.partido.split(" vs ")[1],
        analysis: parsed,
        expires_at: new Date(fila.kickoffTs * 1000).toISOString(),
      }),
    });
    if (!r.ok) {
      if (++fallosGuardadoSeguidos >= 3) cortocircuito = true;
      throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    fallosGuardadoSeguidos = 0;
  };

  const procesar = async (fila) => {
    const datos = await conAF(() => obtenerDatosFixture(fila.id));
    if (!datos?.encontrado) throw new Error(`pipeline: ${datos?.mensaje || "no encontrado"}`);

    const searchData = construirSearchData(datos);
    // COMPUERTA DEFINITIVA de cuotas: el mismo criterio con el que la
    // receta cae a "cuotas estimadas". El /odds rapido de la seleccion
    // filtra barato; este es el veredicto sobre el paquete completo.
    if (searchData.includes("Sin cuotas disponibles")) {
      return { skip: "sin cuotas (compuerta definitiva)" };
    }

    const mensaje = construirMensajeUsuario(
      datos.fixture?.local?.nombre, datos.fixture?.visitante?.nombre, searchData
    );
    const texto = await llamarClaude(mensaje);
    const parsed = parsearRespuestaAnalisis(texto);
    normalizarAnalisis(parsed);
    ordenarMercados(parsed);
    adjuntarTabla(parsed, datos);
    adjuntarAltitud(parsed, datos);
    adjuntarPosts(parsed);
    // Para el futuro "cuotas tomadas hace Xh" y para auditar el cron.
    parsed.generated_at = new Date().toISOString();
    await guardar(fila, parsed);
    return { ok: true };
  };

  const resultado = { generados: 0, sin_cuotas_definitiva: 0, errores: [] };
  let cursor = 0;
  const obrero = async () => {
    while (!cortocircuito && cursor < cola.length) {
      const fila = cola[cursor++];
      let intento = 0;
      for (;;) {
        try {
          const r = await procesar(fila);
          if (r.skip) { resultado.sin_cuotas_definitiva++; fila.decision = `salta ${r.skip}`; }
          else { resultado.generados++; fila.decision = "generado"; }
          console.log(`  [${fila.decision}] ${fila.partido}`);
          break;
        } catch (e) {
          // Un reintento por fixture; el fallo de uno NO aborta la corrida —
          // salvo cortocircuito, que corta tambien el reintento: repetir
          // procesar() volveria a pagar Claude para fallar en el guardado.
          if (!cortocircuito && intento++ < 1) { await dormir(2000); continue; }
          resultado.errores.push({ id: fila.id, partido: fila.partido, error: e.message });
          fila.decision = `error: ${e.message.slice(0, 80)}`;
          console.log(`  [error] ${fila.partido}: ${e.message.slice(0, 120)}`);
          break;
        }
      }
    }
  };
  await Promise.all([obrero(), obrero()]);

  // ── Poda: fuera de la despensa lo expirado hace mas de 7 dias ──────
  // Nada mas la borra (el upsert nunca elimina); sin poda, la tabla — de
  // lectura publica — acumularia anos de pronosticos muertos. Si falla,
  // se avisa y se continua: es limpieza, no cocina.
  let podados = 0;
  try {
    const limite = new Date(Date.now() - 7 * 86400000).toISOString();
    const r = await fetch(
      `${SUPA_URL}/rest/v1/analysis_cache?expires_at=lt.${limite}&select=fixture_id`,
      { method: "DELETE", headers: { ...cabecerasSupa(SUPA_KEY), Prefer: "return=representation" } }
    );
    const borradas = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(borradas).slice(0, 120));
    podados = Array.isArray(borradas) ? borradas.length : 0;
  } catch (e) {
    console.error(`(aviso) poda fallida (${e.message.slice(0, 100)}): se continua`);
  }

  // Cerrar la corrida en el cuaderno. cuenta() lee las decisiones YA
  // mutadas, asi que "salta sin cuotas" suma el filtro rapido y la
  // compuerta definitiva, y "error" suma los de cuotas y los de cocina.
  if (filaCuaderno?.id != null) {
    await cuaderno("PATCH", `cron_runs?id=eq.${filaCuaderno.id}`, {
      finished_at: new Date().toISOString(),
      generados: resultado.generados,
      saltados_sin_cuotas: cuenta("salta sin cuotas"),
      errores: cuenta("error"),
      podados,
      detalle: { max: MAX, cortocircuito, errores: resultado.errores },
    });
  }

  console.log(`\nRESUMEN REAL: generados=${resultado.generados} | salta compuerta definitiva=${resultado.sin_cuotas_definitiva} | errores=${resultado.errores.length} | podados=${podados} | cuaderno=${filaCuaderno ? `fila ${filaCuaderno.id}` : "no disponible"}${cortocircuito ? " | CORTACIRCUITOS: detenido tras 3 guardados fallidos consecutivos" : ""}`);
  for (const e of resultado.errores) console.log(`  - ${e.partido} (${e.id}): ${e.error.slice(0, 160)}`);
  if (cortocircuito) process.exitCode = 1;
  else if (resultado.errores.length && resultado.generados === 0 && cola.length > 0) process.exitCode = 1;
}
