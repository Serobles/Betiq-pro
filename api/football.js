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

  // ── Deteccion de errores de API-Football ──────────────────────────
  // La API avisa de casi todos los fallos con HTTP 200 y un campo `errors`
  // en el cuerpo. Trampa importante: cuando NO hay error, `errors` llega
  // como array VACIO ([]), que en JS es truthy — por eso un `if (d.errors)`
  // da siempre positivo y no sirve para detectar nada. Solo hay error real
  // si es un objeto con claves o un array con elementos.
  const erroresDe = (d) => {
    const e = d?.errors;
    if (!e) return null;
    if (typeof e === "string") return e.trim() ? { general: e } : null;
    if (Array.isArray(e)) return e.length ? { general: e.join(" ") } : null;
    if (typeof e === "object") return Object.keys(e).length ? e : null;
    return null;
  };

  const TIPOS = {
    LIMITE: "limite_peticiones",
    CLAVE: "clave_invalida",
    PLAN: "plan_insuficiente",
    PARAMETRO: "parametro_invalido",
    DESCONOCIDO: "error_api",
  };

  // Traduce el `errors` de la API a un motivo concreto. Los casos se
  // distinguen por la CLAVE del error (que es estable) y solo se recurre al
  // texto como refuerzo. Formas verificadas contra la API real:
  //   clave mala      -> HTTP 403 + { token: "Invalid API key..." }
  //   parametro malo  -> HTTP 200 + { search: "The Search field must be..." }
  //   endpoint malo   -> HTTP 200 + { endpoint: "The ... does not exist." }
  // Cuota y plan siguen las claves documentadas (`requests`, `plan`) y el
  // HTTP 429 del limite por minuto.
  const clasificar = (errores, status) => {
    const claves = Object.keys(errores).map((k) => k.toLowerCase());
    const texto = Object.values(errores).join(" ").toLowerCase();
    const detalle = Object.entries(errores)
      .map(([k, v]) => (k === "general" ? v : `${k}: ${v}`))
      .join(" | ");

    if (
      status === 429 ||
      claves.includes("requests") ||
      /request limit|rate limit|too many requests/.test(texto)
    ) {
      return {
        tipo: TIPOS.LIMITE,
        mensaje: `Se alcanzo el limite de peticiones de API-Football (${detalle}). No es que falten datos del partido: la cuenta no puede consultar mas por ahora.`,
      };
    }

    if (
      status === 401 ||
      status === 403 ||
      claves.includes("token") ||
      /api key|application key/.test(texto)
    ) {
      return {
        tipo: TIPOS.CLAVE,
        mensaje: `API-Football rechazo la clave de acceso (${detalle}). Revisa la variable API_FOOTBALL_KEY.`,
      };
    }

    if (claves.includes("plan") || /subscription plan|your plan/.test(texto)) {
      return {
        tipo: TIPOS.PLAN,
        mensaje: `El plan contratado de API-Football no permite esta consulta (${detalle}).`,
      };
    }

    if (claves.includes("endpoint")) {
      return {
        tipo: TIPOS.PARAMETRO,
        mensaje: `API-Football no reconoce el endpoint solicitado (${detalle}).`,
      };
    }

    return {
      tipo: TIPOS.PARAMETRO,
      mensaje: `API-Football rechazo la peticion por un parametro no admitido (${detalle}).`,
    };
  };

  class ErrorApiFootball extends Error {
    constructor({ tipo, mensaje, endpoint }) {
      super(mensaje);
      this.name = "ErrorApiFootball";
      this.tipo = tipo;
      this.endpoint = endpoint;
    }
  }

  // Unico punto por el que se habla con la API: centraliza el parseo y
  // convierte cualquier `errors` en una excepcion tipada, para que un fallo
  // de la API no pueda disfrazarse mas de "no hay datos".
  const pedir = async (ruta) => {
    const r = await fetch(`${BASE}${ruta}`, { headers });

    let d;
    try {
      d = await r.json();
    } catch {
      throw new ErrorApiFootball({
        tipo: TIPOS.DESCONOCIDO,
        mensaje: `API-Football devolvio una respuesta ilegible (HTTP ${r.status}).`,
        endpoint: ruta,
      });
    }

    const errores = erroresDe(d);
    if (errores) {
      const { tipo, mensaje } = clasificar(errores, r.status);
      throw new ErrorApiFootball({ tipo, mensaje, endpoint: ruta });
    }

    if (!r.ok) {
      throw new ErrorApiFootball({
        tipo: TIPOS.DESCONOCIDO,
        mensaje: `API-Football respondio HTTP ${r.status} sin detallar el motivo.`,
        endpoint: ruta,
      });
    }

    return d;
  };

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
      // La API exige 3 caracteres en `search`: filtrar aqui evita gastar una
      // peticion para que la respuesta sea un error de parametro.
      if (!termino || termino.length < 3) return [];
      const d = await pedir(`/teams?search=${encodeURIComponent(termino)}`);
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
    const h2hData = await pedir(
      `/fixtures/headtohead?h2h=${equipoLocal.id}-${equipoVisitante.id}`
    );
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
    // Estas cinco consultas enriquecen el partido ya localizado. Si una falla
    // por un parametro concreto se sigue adelante sin ella, pero se deja
    // constancia en `avisos`: un hueco por error NO debe leerse como un dato
    // confirmado. Un fallo de cuota, clave o plan si aborta, porque afecta a
    // todas por igual y devolver huecos seria mentir sobre el partido.
    const avisos = [];

    const pedirOpcional = async (ruta, etiqueta) => {
      try {
        return await pedir(ruta);
      } catch (e) {
        if (!(e instanceof ErrorApiFootball)) throw e;
        if (
          e.tipo === TIPOS.LIMITE ||
          e.tipo === TIPOS.CLAVE ||
          e.tipo === TIPOS.PLAN
        ) {
          throw e;
        }
        avisos.push(`${etiqueta}: ${e.message}`);
        return null;
      }
    };

    const [injuriesData, oddsData, statsHomeData, statsAwayData, standingsData] =
      await Promise.all([
        // Lesionados del partido
        pedirOpcional(`/injuries?fixture=${fixtureId}`, "Lesionados"),
        // Cuotas de casas de apuestas (Bet365 = bookmaker 8)
        pedirOpcional(`/odds?fixture=${fixtureId}&bookmaker=8`, "Cuotas"),
        // Estadísticas del equipo local en la liga
        pedirOpcional(
          `/teams/statistics?team=${homeTeamId}&league=${leagueId}&season=${season}`,
          "Estadisticas del local"
        ),
        // Estadísticas del equipo visitante
        pedirOpcional(
          `/teams/statistics?team=${awayTeamId}&league=${leagueId}&season=${season}`,
          "Estadisticas del visitante"
        ),
        // Tabla de posiciones
        pedirOpcional(`/standings?league=${leagueId}&season=${season}`, "Tabla de posiciones"),
      ]);

    // ── 4. Procesar lesionados ────────────────────────────────────────
    // La duplicacion viene de origen: /injuries?fixture= devuelve CADA fila
    // repetida tal cual. Comprobado sobre 24 partidos de las cinco grandes
    // ligas: 318 filas para 159 jugadores reales, factor 2.00x exacto en
    // todos, sin una sola discrepancia de type/reason entre las copias.
    // Tampoco se arregla afinando la peticion — añadir team, league o season
    // a la query devuelve el mismo 2.00x — asi que no hay forma de pedirle a
    // la API que no duplique. Por eso se colapsa aqui, al ENTRAR el dato y
    // por identidad de jugador, en vez de limpiar el texto ya formateado.
    const injuries = injuriesData?.response || [];

    // Una baja confirmada pesa mas que una duda. No se han observado copias
    // discrepantes, pero si algun dia llegan nos quedamos con la peor y con
    // la que traiga motivo concreto, no con la que llegue primero.
    // "Missing Fixture" = no juega seguro; "Questionable" = duda hasta el
    // once inicial. La diferencia importa para el analisis, asi que se
    // traduce en vez de perderse.
    const ESTADOS = {
      "missing fixture": "Baja confirmada",
      questionable: "En duda",
    };
    const estadoBaja = (t) =>
      ESTADOS[normalizar(t)] || (t ? String(t) : "Estado no informado");

    const GRAVEDAD = { "missing fixture": 2, questionable: 1 };
    const gravedadDe = (r) => GRAVEDAD[normalizar(r.player?.type)] ?? 0;
    const tieneMotivo = (r) => Boolean((r.player?.reason || "").trim());

    const prevalece = (nuevo, previo) => {
      const dg = gravedadDe(nuevo) - gravedadDe(previo);
      if (dg !== 0) return dg > 0;
      return tieneMotivo(nuevo) && !tieneMotivo(previo);
    };

    // player.id es el identificador estable (presente en las 318 filas de la
    // muestra). El nombre normalizado solo actua de red de seguridad si la
    // API lo omitiera, para no agrupar a dos jugadores bajo un mismo
    // "undefined".
    const identidad = (r) =>
      `${r.team?.id ?? "sin-equipo"}:${r.player?.id ?? `n:${normalizar(r.player?.name)}`}`;

    const lesionadosDe = (teamId) => {
      const porJugador = new Map();
      for (const r of injuries) {
        if (r.team?.id !== teamId) continue;
        const clave = identidad(r);
        const previo = porJugador.get(clave);
        if (!previo || prevalece(r, previo)) porJugador.set(clave, r);
      }
      return [...porJugador.values()].map((r) => ({
        nombre: r.player?.name,
        // OJO: player.type es el TIPO DE BAJA, no la demarcacion. Antes se
        // mandaba como `posicion` y la IA acababa leyendo que Mount jugaba
        // de "Questionable". /injuries no trae la posicion por ningun lado,
        // asi que no se manda ninguna: mejor sin dato que con uno inventado.
        estado: estadoBaja(r.player?.type),
        motivo: r.player?.reason,
      }));
    };

    const lesionados_local = lesionadosDe(homeTeamId);
    const lesionados_visitante = lesionadosDe(awayTeamId);

    // ── 5. Procesar cuotas Bet365 ─────────────────────────────────────
    const bets = oddsData?.response?.[0]?.bookmakers?.[0]?.bets || [];

    const odds = bets.map((bet) => ({
      mercado: bet.name,
      valores: bet.values,
    }));

    // ── 6. Procesar estadísticas ──────────────────────────────────────
    const sh = statsHomeData?.response || null;
    const sv = statsAwayData?.response || null;

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
    const allStandings = standingsData?.response?.[0]?.league?.standings?.flat() || [];

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
      // Bloques que la API rechazo. Si esto no esta vacio, los huecos
      // correspondientes son "no se pudo consultar", no "no hay nada".
      avisos,
      lesionados_disponibles: injuriesData !== null,
    });
  } catch (error) {
    // Fallo identificado de la API (cuota, clave, plan, parametro). Se
    // responde 200 a proposito: el frontend solo lee el cuerpo cuando la
    // respuesta es ok, y aqui lo que importa es que el motivo real llegue
    // entero en vez de perderse tras un 5xx.
    if (error instanceof ErrorApiFootball) {
      return res.status(200).json({
        ...vacio,
        error_api: true,
        tipo_error: error.tipo,
        endpoint: error.endpoint,
        mensaje: `${error.message} Se usara busqueda web como respaldo.`,
      });
    }

    // Fallo no atribuible a la API (red caida, bug propio).
    return res.status(500).json({
      error: error.message,
      encontrado: false,
      error_api: false,
      tipo_error: "fallo_interno",
      mensaje: "Error consultando API-Football. Se usará búsqueda web como respaldo.",
    });
  }
}
