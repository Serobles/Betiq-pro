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
  adjuntarTabla,
  adjuntarPosts,
} from "../api/_analysis.js";

// ── Flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const SONDA = args.includes("--sonda");
// Precedencia si llegan los dos: gana la sonda (solo lectura) y el
// sembrador se ignora con aviso — el modo que escribe nunca se activa
// por descuido de marcar dos casillas.
const SEMBRAR = !SONDA && args.includes("--sembrar-estadios");
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
// La sonda y el sembrador ignoran --dry-run, --max y --fixture.
if (SONDA) console.log(`SONDA: solo lectura del mercado | ventana=72h | disparador=${DISPARADOR}`);
else if (SEMBRAR) console.log(`SEMBRADOR DE ESTADIOS: /teams de las ligas → estadios + equipos_estadio | disparador=${DISPARADOR}`);
else console.log(`COCINERO — modo=${DRY ? "ENSAYO" : "REAL"} | max=${MAX} | disparador=${DISPARADOR}`);
if (SONDA && args.includes("--sembrar-estadios"))
  console.error("(aviso) --sembrar-estadios ignorado: la sonda (solo lectura) tiene precedencia");

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
// lista completa, no a mitad de corrida. La sonda no cocina ni escribe:
// con --sonda basta API_FOOTBALL_KEY y no se exige nada mas. El sembrador
// no llama a Claude pero SI escribe en Supabase: exige la service key
// (y su formato) aunque lleve --dry-run, que ignora.
if ((!DRY && !SONDA) || SEMBRAR) {
  const faltan = [];
  if (!ANTHROPIC_KEY && !SEMBRAR) faltan.push("ANTHROPIC_API_KEY");
  if (!SUPA_URL) faltan.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) faltan.push("SUPABASE_SERVICE_ROLE_KEY");
  if (faltan.length) {
    console.error(`${SEMBRAR ? "Sembrador" : "Modo real"}: faltan secretos en el entorno: ${faltan.join(", ")}`);
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
const hoyISO = new Date().toISOString().slice(0, 10);
const resolverSeason = async (ligaId) => {
  const d = await af(`/leagues?id=${ligaId}`);
  const s = (d.response?.[0]?.seasons || []).find((x) => x.start <= hoyISO && hoyISO <= x.end);
  return s?.year ?? null;
};

// ── 2. Seleccion: NS con kickoff en [ahora, ahora+ventana], en UTC ────
// El cocinero va en 32h (hastaS); la sonda pide 72h por parametro.
const ahoraS = Math.floor(Date.now() / 1000);
// 32h porque la promesa es despensa 24h antes del kickoff y las corridas van cada ~6-8h (retraso del schedule incluido): peor caso ~24h. Respaldo: sonda 3-sep-2026 (Europa 100% con cuotas a 24-72h; Sudamerica ~89-91%).
const hastaS = ahoraS + 32 * 3600;
const hastaSondaS = ahoraS + 72 * 3600;

// Ligas que la seleccion perdio (season irresoluble o fixtures caidos).
// La sonda las lista en su reporte para que "—" nunca esconda un fallo de
// datos; el cocinero normal no lee esta lista (su red es el fallback en
// vivo, que regenera al abrir el partido).
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
    adjuntarTabla(parsed, datos);
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
