#!/usr/bin/env node
// ── El cocinero: pre-generador de analisis (cron, paso 3) ─────────────
// Recorre las ligas del producto, selecciona los partidos con kickoff en
// las proximas 24h y decide cuales generar. CERO copias de logica: las
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
  adjuntarPosts,
} from "../api/_analysis.js";

// ── Flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const MAX = Number((args.find(a => a.startsWith("--max=")) || "--max=60").slice(6));
const SOLO_FIXTURE = Number((args.find(a => a.startsWith("--fixture=")) || "").slice(10)) || null;

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
// lista completa, no a mitad de corrida.
if (!DRY) {
  const faltan = [];
  if (!ANTHROPIC_KEY) faltan.push("ANTHROPIC_API_KEY");
  if (!SUPA_URL) faltan.push("SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) faltan.push("SUPABASE_SERVICE_ROLE_KEY");
  if (faltan.length) {
    console.error(`Modo real: faltan secretos en el entorno: ${faltan.join(", ")}`);
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
const PAUSA_MS = 250;
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
const af = async (ruta) => {
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

// ── 2. Seleccion: NS con kickoff en [ahora, ahora+24h], en UTC ────────
const ahoraS = Math.floor(Date.now() / 1000);
const hastaS = ahoraS + 86400;
const desdeFecha = new Date(ahoraS * 1000).toISOString().slice(0, 10);
const hastaFecha = new Date(hastaS * 1000).toISOString().slice(0, 10);

const seleccionar = async () => {
  if (SOLO_FIXTURE) {
    const d = await af(`/fixtures?id=${SOLO_FIXTURE}`);
    const f = d.response?.[0];
    if (!f) { console.error(`El fixture ${SOLO_FIXTURE} no existe.`); process.exit(1); }
    return [{ f, liga: `${f.league?.name} (${f.league?.id})` }];
  }

  // season por liga, en tandas
  const seasons = await enTandas(LIGAS, async (l) => ({ id: l.id, season: await resolverSeason(l.id) }));
  const conSeason = LIGAS.map((l, i) => ({ ...l, season: seasons[i]?.season }))
    .filter((l) => l.season != null);

  // fixtures por liga (from/to filtran por DIA de calendario, no por hora:
  // el corte real es fixture.timestamp, unix e inmune a zonas y DST)
  const porLiga = await enTandas(conSeason, async (l) => {
    const d = await af(`/fixtures?league=${l.id}&season=${l.season}&from=${desdeFecha}&to=${hastaFecha}&timezone=UTC`);
    return (d.response || []).map((f) => ({ f, liga: l.nombre }));
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

  console.log(`\nRESUMEN REAL: generados=${resultado.generados} | salta compuerta definitiva=${resultado.sin_cuotas_definitiva} | errores=${resultado.errores.length}${cortocircuito ? " | CORTACIRCUITOS: detenido tras 3 guardados fallidos consecutivos" : ""}`);
  for (const e of resultado.errores) console.log(`  - ${e.partido} (${e.id}): ${e.error.slice(0, 160)}`);
  if (cortocircuito) process.exitCode = 1;
  else if (resultado.errores.length && resultado.generados === 0 && cola.length > 0) process.exitCode = 1;
}
