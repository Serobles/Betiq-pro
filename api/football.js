export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  const { local, visitante } = req.body;
  const API_KEY = process.env.API_FOOTBALL_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY no configurada" });
  }

  // ── Validación de entrada ─────────────────────────────────────────
  const localNombre = typeof local === "string" ? local.trim() : "";
  const visitanteNombre = typeof visitante === "string" ? visitante.trim() : "";

  if (!localNombre || !visitanteNombre) {
    return res.status(400).json({
      error: "Faltan los nombres de los equipos: 'local' y 'visitante' son obligatorios",
    });
  }

  const headers = {
    "x-apisports-key": API_KEY,
    "Content-Type": "application/json",
  };

  const BASE = "https://v3.football.api-sports.io";

  // Respuesta vacía reutilizable cuando no se puede localizar el partido
  const vacio = {
    encontrado: false,
    fixture: null,
    lesionados_local: [],
    lesionados_visitante: [],
    odds: [],
    stats_local: null,
    stats_visitante: null,
  };

  try {
    // ── 1. Resolver el ID de cada equipo por su nombre ────────────────
    // Su base guarda algunos nombres abreviados ("Independ. Rivadavia"),
    // así que la búsqueda directa puede devolver 0 resultados y hay que
    // reintentar con las palabras distintivas del nombre.

    const normalizar = (s) =>
      (s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

    // Palabras que no distinguen a un club de otro. Ojo: atletico, real,
    // deportivo y sporting NO van aqui — en España son justo lo que separa
    // al Atletico del Real Madrid.
    const GENERICAS = new Set([
      "fc", "cf", "ca", "cd", "sc", "ac", "afc", "club", "de", "del", "la",
      "el", "los", "union", "united", "city", "san", "santa",
    ]);

    // Filiales, juveniles y femeninos: casi nunca son el equipo buscado
    const ES_FILIAL =
      /(^| )(u1[5-9]|u2[0-3]|sub[0-9]{2}|w|women|femenino|fem|res|reserve|reserves|ii|b)( |$)/;

    const palabrasClave = (nombre) =>
      normalizar(nombre)
        .split(" ")
        .filter((p) => p.length > 2 && !GENERICAS.has(p));

    // Una palabra del nombre buscado (c) casa con una de la API (p) si son
    // iguales, si la API la abrevia ("Independ." por "Independiente") o si la
    // alarga con un sufijo minimo. Lo que NO vale es que solo compartan el
    // principio: "madridtas" no es "madrid".
    const casaPalabra = (p, c) => {
      if (p === c) return true;
      // La API abrevia: p es prefijo de c y conserva la mayor parte
      if (c.startsWith(p) && p.length >= 5 && p.length / c.length >= 0.6) return true;
      // La API alarga: solo se admiten hasta 2 caracteres de mas
      if (p.startsWith(c) && c.length >= 5 && p.length - c.length <= 2) return true;
      return false;
    };

    const puntuar = (nombreApi, claves) => {
      const palabras = normalizar(nombreApi).split(" ");
      return claves.reduce(
        (n, c) => (palabras.some((p) => casaPalabra(p, c)) ? n + 1 : n),
        0
      );
    };

    // Gana quien mas palabras del nombre buscado encuentre. A igualdad de
    // aciertos gana el candidato cuyo propio nombre queda mejor explicado por
    // esas palabras: "Atletico Madrid" (2 de 2) por delante de "Real Madrid"
    // (1 de 2). La longitud solo desempata al final.
    const elegirMejor = (candidatos, claves) => {
      let mejor = null;
      let mejorTotal = 0;
      for (const c of candidatos) {
        const nombreApi = c.team?.name || "";
        const aciertos = puntuar(nombreApi, claves);
        if (aciertos === 0) continue;
        const norm = normalizar(nombreApi);
        const cobertura = Math.min(1, aciertos / norm.split(" ").length);
        const total =
          aciertos +
          cobertura * 0.5 -
          (ES_FILIAL.test(norm) ? 1.5 : 0) -
          norm.length / 10000;
        if (total > mejorTotal) {
          mejorTotal = total;
          mejor = c.team;
        }
      }
      return mejor;
    };

    const consultarEquipos = async (termino) => {
      const r = await fetch(
        `${BASE}/teams?search=${encodeURIComponent(termino)}`,
        { headers }
      );
      const d = await r.json();
      return d.response || [];
    };

    const buscarEquipo = async (nombre) => {
      const claves = palabrasClave(nombre);
      const candidatos = await consultarEquipos(nombre);
      const directo = elegirMejor(candidatos, claves);

      // Si ya casan todas las palabras del nombre, no hace falta reintentar
      if (directo && puntuar(directo.name, claves) === claves.length) {
        return directo;
      }

      // Reintento con las palabras distintivas (máximo 2 peticiones extra)
      const porPalabra = await Promise.all(
        claves.slice(0, 2).map((p) => consultarEquipos(p))
      );

      const todos = [...candidatos, ...porPalabra.flat()];
      const unicos = [
        ...new Map(todos.map((c) => [c.team?.id, c])).values(),
      ];

      // Último recurso: el primer resultado de la búsqueda directa
      return elegirMejor(unicos, claves) || directo || candidatos[0]?.team || null;
    };

    const [equipoLocal, equipoVisitante] = await Promise.all([
      buscarEquipo(localNombre),
      buscarEquipo(visitanteNombre),
    ]);

    if (!equipoLocal || !equipoVisitante) {
      const faltante = !equipoLocal ? localNombre : visitanteNombre;
      return res.status(200).json({
        ...vacio,
        mensaje: `Equipo no encontrado en API-Football: "${faltante}". Se usará búsqueda web como respaldo.`,
      });
    }

    // ── 2. Próximo enfrentamiento directo entre ambos ─────────────────
    // El parámetro `next` no está disponible en todos los planes, así que
    // se pide el historial completo y se elige aquí el primer partido
    // cuya fecha esté por delante de ahora.
    const h2hRes = await fetch(
      `${BASE}/fixtures/headtohead?h2h=${equipoLocal.id}-${equipoVisitante.id}`,
      { headers }
    );
    const h2hData = await h2hRes.json();
    const enfrentamientos = h2hData.response || [];

    const ahora = Date.now();
    const match = enfrentamientos
      .filter((f) => {
        const t = new Date(f.fixture?.date).getTime();
        return Number.isFinite(t) && t > ahora;
      })
      .sort(
        (a, b) =>
          new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime()
      )[0];

    if (!match) {
      return res.status(200).json({
        ...vacio,
        mensaje: `No hay un próximo enfrentamiento programado entre ${equipoLocal.name} y ${equipoVisitante.name} (se revisaron ${enfrentamientos.length} enfrentamientos anteriores). Se usará búsqueda web como respaldo.`,
      });
    }

    const fixtureId = match.fixture.id;
    const leagueId = match.league.id;
    const season = match.league.season;
    const homeTeamId = match.teams.home.id;
    const awayTeamId = match.teams.away.id;

    // ── 3. Llamadas paralelas para máxima velocidad ───────────────────
    const [injuriesRes, oddsRes, statsHomeRes, statsAwayRes, standingsRes] =
      await Promise.all([
        // Lesionados del partido
        fetch(`${BASE}/injuries?fixture=${fixtureId}`, { headers }),
        // Cuotas de casas de apuestas (Bet365 = bookmaker 8)
        fetch(`${BASE}/odds?fixture=${fixtureId}&bookmaker=8`, { headers }),
        // Estadísticas del equipo local en la liga
        fetch(
          `${BASE}/teams/statistics?team=${homeTeamId}&league=${leagueId}&season=${season}`,
          { headers }
        ),
        // Estadísticas del equipo visitante
        fetch(
          `${BASE}/teams/statistics?team=${awayTeamId}&league=${leagueId}&season=${season}`,
          { headers }
        ),
        // Tabla de posiciones
        fetch(
          `${BASE}/standings?league=${leagueId}&season=${season}`,
          { headers }
        ),
      ]);

    const [injuriesData, oddsData, statsHomeData, statsAwayData, standingsData] =
      await Promise.all([
        injuriesRes.json(),
        oddsRes.json(),
        statsHomeRes.json(),
        statsAwayRes.json(),
        standingsRes.json(),
      ]);

    // ── 4. Procesar lesionados ────────────────────────────────────────
    const injuries = injuriesData.response || [];

    const lesionados_local = injuries
      .filter((i) => i.team?.id === homeTeamId)
      .map((i) => ({
        nombre: i.player?.name,
        posicion: i.player?.type,
        motivo: i.player?.reason,
      }));

    const lesionados_visitante = injuries
      .filter((i) => i.team?.id === awayTeamId)
      .map((i) => ({
        nombre: i.player?.name,
        posicion: i.player?.type,
        motivo: i.player?.reason,
      }));

    // ── 5. Procesar cuotas Bet365 ─────────────────────────────────────
    const bets = oddsData.response?.[0]?.bookmakers?.[0]?.bets || [];

    const odds = bets.map((bet) => ({
      mercado: bet.name,
      valores: bet.values,
    }));

    // ── 6. Procesar estadísticas ──────────────────────────────────────
    const sh = statsHomeData.response || null;
    const sv = statsAwayData.response || null;

    const procesar_stats = (s) => {
      if (!s) return null;
      return {
        partidos_jugados: s.fixtures?.played?.total,
        ganados: s.fixtures?.wins?.total,
        empatados: s.fixtures?.draws?.total,
        perdidos: s.fixtures?.loses?.total,
        goles_favor: s.goals?.for?.total?.total,
        goles_contra: s.goals?.against?.total?.total,
        promedio_goles_favor: s.goals?.for?.average?.total,
        promedio_goles_contra: s.goals?.against?.average?.total,
        forma: s.form,
        mayor_racha_victorias: s.biggest?.streak?.wins,
        mayor_racha_derrotas: s.biggest?.streak?.loses,
        goles_primer_tiempo: s.goals?.for?.minute?.["0-15"]?.total +
          (s.goals?.for?.minute?.["16-30"]?.total || 0) +
          (s.goals?.for?.minute?.["31-45"]?.total || 0),
      };
    };

    // ── 7. Posición en tabla ──────────────────────────────────────────
    const allStandings = standingsData.response?.[0]?.league?.standings?.flat() || [];

    const posLocal = allStandings.find((t) => t.team?.id === homeTeamId);
    const posVisit = allStandings.find((t) => t.team?.id === awayTeamId);

    return res.status(200).json({
      encontrado: true,
      fixture: {
        id: fixtureId,
        fecha: match.fixture.date,
        estadio: match.fixture.venue?.name,
        ciudad: match.fixture.venue?.city,
        arbitro: match.fixture.referee,
        liga: match.league.name,
        pais: match.league.country,
        temporada: season,
        local: {
          id: homeTeamId,
          nombre: match.teams.home.name,
          logo: match.teams.home.logo,
        },
        visitante: {
          id: awayTeamId,
          nombre: match.teams.away.name,
          logo: match.teams.away.logo,
        },
      },
      lesionados_local,
      lesionados_visitante,
      odds,
      stats_local: procesar_stats(sh),
      stats_visitante: procesar_stats(sv),
      posicion_local: posLocal
        ? { pos: posLocal.rank, pts: posLocal.points, forma: posLocal.form }
        : null,
      posicion_visitante: posVisit
        ? { pos: posVisit.rank, pts: posVisit.points, forma: posVisit.form }
        : null,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      encontrado: false,
      mensaje: "Error consultando API-Football. Se usará búsqueda web como respaldo.",
    });
  }
}
