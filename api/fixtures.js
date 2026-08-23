// Calendario de partidos: 5 dias (anteayer .. pasado manana) de las ligas
// de prueba, agrupados en la hora local del usuario.
//
// La agrupacion por dia la hace la API con su parametro `timezone`, no
// nosotros: el futbol sudamericano se juega de noche, que en UTC ya es el dia
// siguiente, asi que agrupar por UTC manda 3 de cada 10 partidos colombianos
// al dia equivocado.

const BASE = "https://v3.football.api-sports.io";

// Orden de la lista = orden en pantalla. Colombia primero y el resto de
// Sudamerica, despues las 5 grandes europeas, y los torneos continentales al
// final. Las UEFA (Champions, Europa League, Conference) siguen en pausa
// hasta que la API cargue su fase principal.
//
// Ojo con Paraguay: el 250 (Apertura) esta muerto — su temporada cerro el
// 24-may-2026 y devuelve 0 partidos — pero la API lo sigue marcando como
// `current`. El vivo es el 252 (Clausura). Por eso las ligas se verifican por
// fechas reales y por que devuelvan fixtures, nunca por ese flag.
const LIGAS = [
  { id: 239, nombre: "Colombia · Primera A" },
  { id: 71, nombre: "Brasil · Serie A" },
  { id: 128, nombre: "Argentina · Liga Profesional" },
  { id: 242, nombre: "Ecuador · Liga Pro" },
  { id: 265, nombre: "Chile · Primera División" },
  { id: 268, nombre: "Uruguay · Primera División" },
  { id: 281, nombre: "Perú · Primera División" },
  { id: 252, nombre: "Paraguay · Clausura" },
  { id: 344, nombre: "Bolivia · Primera División" },
  { id: 299, nombre: "Venezuela · Primera División" },
  // Europeas (verificadas 23-ago-2026 por fechas reales y fixtures):
  // la Bundesliga 2026/27 arranca el 28-ago-2026 — hasta ese dia no pinta
  // partidos, y ese dia se enciende sola sin tocar nada.
  { id: 39, nombre: "Inglaterra · Premier League" },
  { id: 140, nombre: "España · LaLiga" },
  { id: 135, nombre: "Italia · Serie A" },
  { id: 78, nombre: "Alemania · Bundesliga" },
  { id: 61, nombre: "Francia · Ligue 1" },
  { id: 13, nombre: "Copa Libertadores" },
  { id: 11, nombre: "Copa Sudamericana" },
];

// La API corta las rafagas: pedir las 12 ligas a la vez pierde entre 1 y 4 de
// forma reproducible, incluso con la ventana de cuota recien reseteada (12 en
// paralelo -> 8/12 y 11/12 en dos pruebas; escalonadas -> 12/12). No es la
// cuota diaria ni el limite por minuto, es la concurrencia. Por eso las ligas
// salen en tandas pequenas con una pausa entre ellas.
const TANDA = 4;
const PAUSA_MS = 250;

// Pausa previa al reintento de las ligas que fallaron. Mas larga que la de
// entre tandas: si el tropiezo fue el limite por minuto, reintentar de
// inmediato volveria a fallar seguro.
const PAUSA_REINTENTO_MS = 1500;

// Cache por instancia: ni las zonas horarias ni la temporada en curso cambian
// de un minuto a otro.
let zonasValidas = null;
const seasonPorLiga = new Map();

// Cache CORTO de la lista de partidos, por zona horaria y ventana de dias.
// Nada que ver con el cache de analisis por fixture_id: aquel guarda el
// pronostico de la IA durante horas, este solo evita repetir las 17 peticiones
// del listado cuando el usuario va y viene (el "Volver" de la vista de
// analisis desmonta el calendario y lo haria pedir todo otra vez).
//
// 3 minutos es el equilibrio: cubre de sobra la navegacion ida y vuelta, y
// deja el marcador en vivo desfasado como mucho ese rato.
const TTL_MS = 3 * 60 * 1000;
const listaCache = new Map();

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  const API_KEY = process.env.API_FOOTBALL_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY no configurada" });
  }

  const headers = { "x-apisports-key": API_KEY, "Content-Type": "application/json" };

  // Mismo detalle que en football.js: cuando NO hay error la API manda
  // `errors: []`, un array vacio que en JS es truthy. Solo hay error real si
  // es un objeto con claves o un array con elementos.
  const pedir = async (ruta) => {
    const r = await fetch(`${BASE}${ruta}`, { headers });
    const d = await r.json();
    const e = d?.errors;
    const hayError = Array.isArray(e)
      ? e.length > 0
      : Boolean(e && typeof e === "object" && Object.keys(e).length > 0);
    if (hayError) {
      throw new Error(
        Object.entries(e).map(([k, v]) => `${k}: ${v}`).join(" | ")
      );
    }
    return d;
  };

  const fechaEnZona = (fecha, zona) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: zona,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(fecha);

  try {
    const solicitada =
      typeof req.body?.timezone === "string" ? req.body.timezone.trim() : "";

    // Una zona que la API no conoce NO da error: la ignora en silencio y
    // responde en UTC. Si no se comprueba, el calendario saldria mal agrupado
    // sin que nada lo delate, que es justo lo que hay que evitar.
    if (!zonasValidas) {
      const z = await pedir("/timezone");
      zonasValidas = new Set(z.response || []);
    }
    const soportada = zonasValidas.has(solicitada);
    const zona = soportada ? solicitada : "UTC";

    // Los 5 dias se calculan en la MISMA zona con la que se piden los
    // partidos, para que las cabeceras y las fechas devueltas encajen.
    const hoy = fechaEnZona(new Date(), zona);
    const ancla = new Date(`${hoy}T00:00:00Z`);
    const dias = [-2, -1, 0, 1, 2].map((n) =>
      new Date(ancla.getTime() + n * 86400000).toISOString().slice(0, 10)
    );

    // Servir del cache si sigue fresco. La clave lleva zona y ventana: dos
    // usuarios en zonas distintas ven dias distintos, y al cambiar el dia la
    // clave cambia sola.
    const clave = `${zona}|${dias[0]}`;
    const guardado = listaCache.get(clave);
    if (guardado && guardado.expira > Date.now()) {
      // zona_solicitada/soportada son del que pregunta ahora, no del primer
      // usuario que lleno el cache (la lista de partidos si es compartible:
      // la clave ya garantiza misma zona resuelta y misma ventana).
      return res.status(200).json({
        ...guardado.payload,
        zona_solicitada: solicitada,
        zona_soportada: soportada,
        desde_cache: true,
      });
    }

    // `season` es obligatorio junto a league+from+to, y no se puede pedir mas
    // de una liga por llamada (el parametro repetido se pisa), asi que va una
    // peticion por liga.
    const cargarLiga = async (liga) => {
        if (!seasonPorLiga.has(liga.id)) {
          const l = await pedir(`/leagues?id=${liga.id}&current=true`);
          const year = l.response?.[0]?.seasons?.[0]?.year;
          if (year) seasonPorLiga.set(liga.id, year);
        }
        const season = seasonPorLiga.get(liga.id);
        if (!season) return [];

        const d = await pedir(
          `/fixtures?league=${liga.id}&season=${season}` +
            `&from=${dias[0]}&to=${dias[4]}` +
            `&timezone=${encodeURIComponent(zona)}`
        );
        return (d.response || []).map((f) => ({
          id: f.fixture.id,
          // La API ya devuelve la fecha en la zona pedida, asi que el dia y la
          // hora salen directos del propio texto ISO.
          fecha: f.fixture.date.slice(0, 10),
          hora: f.fixture.date.slice(11, 16),
          // Unix en segundos. Es lo que decide la ventana de 24h: no depende
          // de zona horaria ni de parsear texto.
          timestamp: f.fixture.timestamp,
          local: f.teams.home.name,
          visitante: f.teams.away.name,
          // `goals` es el marcador vigente en CUALQUIER estado, en vivo
          // incluido; score.fulltime solo se rellena cuando acaba.
          goles_local: f.goals.home,
          goles_visitante: f.goals.away,
          // El ganador ya viene resuelto por la API. En empate los dos
          // llegan como null, asi que ninguno queda en negrita.
          gana_local: f.teams.home.winner === true,
          gana_visitante: f.teams.away.winner === true,
          estado: f.fixture.status.short,
          minuto: f.fixture.status.elapsed,
        }));
    };

    // Tandas pequenas + allSettled: escalonar evita que la API corte, y si aun
    // asi cae una liga se pintan las demas en vez de quedarse el calendario en
    // blanco. Antes un solo fallo tumbaba las once restantes.
    //
    // `porLiga` va indexado como LIGAS (el payload lo lee por posicion), asi
    // que una pasada puede rellenar solo los huecos que le toquen y el orden
    // en pantalla no se altera.
    const porLiga = LIGAS.map(() => []);

    // Pide en tandas las ligas de esos indices y devuelve las que fallaron.
    const pasadaEnTandas = async (indices) => {
      const fallidas = [];
      for (let i = 0; i < indices.length; i += TANDA) {
        const tanda = indices.slice(i, i + TANDA);
        const resultados = await Promise.allSettled(
          tanda.map((idx) => cargarLiga(LIGAS[idx]))
        );
        resultados.forEach((r, j) => {
          if (r.status === "fulfilled") porLiga[tanda[j]] = r.value;
          else fallidas.push({ idx: tanda[j], motivo: r.reason?.message || "no respondio" });
        });
        if (i + TANDA < indices.length) await dormir(PAUSA_MS);
      }
      return fallidas;
    };

    const avisos = [];
    let fallidas = await pasadaEnTandas(LIGAS.map((_, i) => i));
    if (fallidas.length) {
      // Reintento silencioso, UNA sola vez y solo de las caidas: un tropiezo
      // puntual se recupera sin que el usuario llegue a ver aviso. Va con su
      // pausa previa y en las mismas tandas, para no meter rafagas nuevas.
      await dormir(PAUSA_REINTENTO_MS);
      fallidas = await pasadaEnTandas(fallidas.map((f) => f.idx));
      fallidas.forEach(({ idx, motivo }) =>
        avisos.push(`${LIGAS[idx].nombre}: ${motivo}`)
      );
    }

    // Jerarquia dia -> liga -> partidos. Las ligas salen en el orden en que
    // estan declaradas en LIGAS (el mismo para todos los dias, asi la lista no
    // baila de un dia a otro); cuando haya mas ligas se decidira la prioridad.
    // Una liga sin partidos ese dia no aparece: el dia queda vacio solo si
    // ninguna tiene.
    const payload = {
      zona_horaria: zona,
      zona_solicitada: solicitada,
      zona_soportada: soportada,
      // Ligas que no respondieron. Si esto no esta vacio, faltan partidos por
      // un fallo, no porque no los haya.
      avisos,
      dias: dias.map((fecha) => ({
        fecha,
        ligas: LIGAS.map((liga, i) => ({
          liga: liga.nombre,
          partidos: porLiga[i]
            .filter((p) => p.fecha === fecha)
            .sort((a, b) => a.hora.localeCompare(b.hora)),
        })).filter((l) => l.partidos.length > 0),
      })),
    };

    // Solo se cachea una carga COMPLETA: guardar una a medias congelaria las
    // ligas caidas durante todo el TTL en vez de reintentarlas.
    if (!avisos.length) {
      // Barrer las entradas caducadas al guardar: las claves llevan el dia,
      // asi que sin poda el mapa creceria sin tope en una instancia longeva.
      for (const [k, v] of listaCache) if (v.expira <= Date.now()) listaCache.delete(k);
      listaCache.set(clave, { expira: Date.now() + TTL_MS, payload });
    }

    return res.status(200).json({ ...payload, desde_cache: false });
  } catch (error) {
    return res.status(200).json({
      dias: [],
      mensaje: `No se pudo cargar el calendario: ${error.message}`,
    });
  }
}
