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
//   node scripts/cocinero.mjs --dry-run [--max=60] [--fixture=ID]
//
// Env: API_FOOTBALL_KEY (siempre), SUPABASE_URL + SUPABASE_ANON_KEY o
// SUPABASE_SERVICE_ROLE_KEY (para el filtro de despensa; en ensayo, si
// faltan, se asume despensa vacia con aviso).

import { LIGAS } from "../api/_ligas.js";
import { obtenerDatosFixture } from "../api/football.js";          // modo real (3b)
import { SYSTEM_PROMPT } from "../api/_analysis.js";               // modo real (3b)

// ── Flags ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const MAX = Number((args.find(a => a.startsWith("--max=")) || "--max=60").slice(6));
const SOLO_FIXTURE = Number((args.find(a => a.startsWith("--fixture=")) || "").slice(10)) || null;

if (!DRY) {
  console.error("El modo real llega en el sub-paso 3b. Por ahora: --dry-run");
  process.exit(1);
}

// ── Credenciales ──────────────────────────────────────────────────────
const AF_KEY = process.env.API_FOOTBALL_KEY;
if (!AF_KEY) {
  console.error("Falta API_FOOTBALL_KEY en el entorno.");
  process.exit(1);
}
const SUPA_URL = process.env.SUPABASE_URL || "";
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

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
  const r = await fetch(
    `${SUPA_URL}/rest/v1/analysis_cache?select=fixture_id,expires_at&fixture_id=in.(${ids.join(",")})`,
    { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
  );
  const filas = await r.json();
  return new Map((Array.isArray(filas) ? filas : []).map((x) => [x.fixture_id, x.expires_at]));
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
console.log(`ENSAYO — ventana UTC ${new Date(ahoraS * 1000).toISOString().slice(0, 16)}Z → ${new Date(hastaS * 1000).toISOString().slice(0, 16)}Z | max=${MAX}\n`);
const ancho = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(`${ancho("liga", 30)} ${ancho("partido", 42)} ${ancho("kickoff UTC", 17)} decision`);
console.log("─".repeat(110));
for (const x of filas) {
  console.log(`${ancho(x.liga, 30)} ${ancho(x.partido, 42)} ${ancho(x.kickoff, 17)} ${x.decision}${x.nota ? `  [${x.nota}]` : ""}`);
}
const cuenta = (d) => filas.filter((x) => x.decision === d || x.decision.startsWith(d)).length;
console.log("─".repeat(110));
console.log(`TOTALES: ${filas.length} en ventana | generar=${cuenta("generar")} | salta cacheado=${cuenta("salta cacheado")} | salta sin cuotas=${cuenta("salta sin cuotas")} | salta status=${cuenta("salta status")} | fuera de tope=${cuenta("fuera de tope")} | errores=${cuenta("error")}`);
console.log(`(ensayo: sin llamadas a Claude, sin escrituras)`);
