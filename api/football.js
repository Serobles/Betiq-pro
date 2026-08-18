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
    // La búsqueda difusa la hace la propia API, así que no dependemos de
    // que el nombre escrito coincida literalmente con el de su base.
    const buscarEquipo = async (nombre) => {
      const r = await fetch(
        `${BASE}/teams?search=${encodeURIComponent(nombre)}`,
        { headers }
      );
      const d = await r.json();
      return d.response?.[0]?.team || null;
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
    // Sin fecha ni zona horaria de por medio: la API devuelve el siguiente
    // partido entre los dos equipos, se juegue el día que se juegue.
    const h2hRes = await fetch(
      `${BASE}/fixtures/headtohead?h2h=${equipoLocal.id}-${equipoVisitante.id}&next=1`,
      { headers }
    );
    const h2hData = await h2hRes.json();
    const match = h2hData.response?.[0];

    if (!match) {
      return res.status(200).json({
        ...vacio,
        mensaje: `No hay un próximo enfrentamiento entre ${equipoLocal.name} y ${equipoVisitante.name} en API-Football. Se usará búsqueda web como respaldo.`,
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
