// Calendario de partidos: 5 dias (anteayer .. pasado manana) de las ligas
// de prueba, agrupados en la hora local del usuario.
//
// La agrupacion por dia la hace la API con su parametro `timezone`, no
// nosotros: el futbol sudamericano se juega de noche, que en UTC ya es el dia
// siguiente, asi que agrupar por UTC manda 3 de cada 10 partidos colombianos
// al dia equivocado.

const BASE = "https://v3.football.api-sports.io";

const LIGAS = [
  { id: 239, nombre: "Colombia · Primera A" },
  { id: 71, nombre: "Brasil · Serie A" },
  { id: 39, nombre: "Premier League" },
];

// Cache por instancia: ni las zonas horarias ni la temporada en curso cambian
// de un minuto a otro, asi que en caliente cada carga cuesta 3 peticiones.
let zonasValidas = null;
const seasonPorLiga = new Map();

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

    // `season` es obligatorio junto a league+from+to, y no se puede pedir mas
    // de una liga por llamada (el parametro repetido se pisa), asi que va una
    // peticion por liga.
    const porLiga = await Promise.all(
      LIGAS.map(async (liga) => {
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
          local: f.teams.home.name,
          visitante: f.teams.away.name,
        }));
      })
    );

    // Jerarquia dia -> liga -> partidos. Las ligas salen en el orden en que
    // estan declaradas en LIGAS (el mismo para todos los dias, asi la lista no
    // baila de un dia a otro); cuando haya mas ligas se decidira la prioridad.
    // Una liga sin partidos ese dia no aparece: el dia queda vacio solo si
    // ninguna tiene.
    return res.status(200).json({
      zona_horaria: zona,
      zona_solicitada: solicitada,
      zona_soportada: soportada,
      dias: dias.map((fecha) => ({
        fecha,
        ligas: LIGAS.map((liga, i) => ({
          liga: liga.nombre,
          partidos: porLiga[i]
            .filter((p) => p.fecha === fecha)
            .sort((a, b) => a.hora.localeCompare(b.hora)),
        })).filter((l) => l.partidos.length > 0),
      })),
    });
  } catch (error) {
    return res.status(200).json({
      dias: [],
      mensaje: `No se pudo cargar el calendario: ${error.message}`,
    });
  }
}
