import { exigirSesion } from "./_auth.js";
import { normalizarArbitro, NOMBRES_MERCADOS_CLAVE } from "./_analysis.js";

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Credenciales de LECTURA de Supabase para los lectores del payload
// (altitudes, arbitros): las mismas de api/_auth.js con respaldo en la
// service key — el unico contexto sin anon key es el cron de Actions.
// Devuelve null si no hay credencial: los lectores responden null y el
// analisis sigue.
const supabaseLectura = () => {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const clave =
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !clave) return null;
  // La sb_secret_ va SOLO en apikey; un JWT (anon o service legacy) va
  // tambien en Authorization — mismo criterio que el cocinero.
  const cabeceras = clave.startsWith("sb_secret_")
    ? { apikey: clave }
    : { apikey: clave, Authorization: `Bearer ${clave}` };
  return { url, cabeceras };
};

// ── Lector de altitudes (Recetario v2b, receta 3) ─────────────────────
// Lee `estadios` y `equipos_estadio` de Supabase (SELECT publica) con las
// mismas credenciales que api/_auth.js y, como respaldo, la service key —
// el unico contexto sin anon key es el cron de GitHub Actions. REGLA
// DURA: sin credencial, tabla ausente o cualquier error → altitudes null
// y se sigue; la altitud jamas rompe ni retrasa un analisis (timeout
// propio de 3s por consulta). Maximo 2 consultas por partido.
const leerAltitudes = async (localTeamId, visitanteTeamId, venuePartidoId) => {
  const nulos = { partido_m: null, local_origen_m: null, visitante_origen_m: null };
  const cred = supabaseLectura();
  if (!cred) return nulos;

  const consulta = async (ruta) => {
    const r = await fetch(`${cred.url}/rest/v1/${ruta}`, {
      headers: cred.cabeceras,
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const filas = await r.json();
    if (!Array.isArray(filas)) throw new Error("respuesta no tabular");
    return filas;
  };

  try {
    // Consulta 1: estadio habitual de ambos equipos (de donde VIENEN).
    const habituales = await consulta(
      `equipos_estadio?select=team_id,venue_id&team_id=in.(${localTeamId},${visitanteTeamId})`
    );
    const venueLocal = habituales.find((x) => x.team_id === localTeamId)?.venue_id ?? null;
    const venueVisit = habituales.find((x) => x.team_id === visitanteTeamId)?.venue_id ?? null;

    // Consulta 2: altitudes de los venue_id involucrados (partido + origenes).
    const ids = [...new Set([venuePartidoId, venueLocal, venueVisit].filter((v) => v != null))];
    if (!ids.length) return nulos;
    const filas = await consulta(
      `estadios?select=venue_id,altitud_m&venue_id=in.(${ids.join(",")})`
    );
    const altitudDe = (vid) =>
      vid == null ? null : filas.find((x) => x.venue_id === vid)?.altitud_m ?? null;

    return {
      partido_m: altitudDe(venuePartidoId),
      local_origen_m: altitudDe(venueLocal),
      visitante_origen_m: altitudDe(venueVisit),
    };
  } catch {
    return nulos;
  }
};

// ── Ficha del arbitro (Recetario v2c, receta 5) ───────────────────────
// Si el fixture trae referee, se busca su historial en arbitro_partidos
// (filas crudas: los promedios se calculan AQUI, al leer). Resolucion en
// dos pasos: (a) clave exacta; (b) si el nombre viene abreviado y no hubo
// match, cruce inicial+apellido contra las claves existentes SOLO con
// candidato UNICO — 0 o 2+ candidatos = sin ficha, jamas se adivina.
// REGLA DURA (patron altitud): cualquier error → null, la ficha jamas
// rompe ni retrasa un analisis (timeout 3s por consulta).
const MUESTRA_MINIMA_ARBITRO = 5; // menos partidos medidos = anecdota, no promedio
const leerArbitro = async (refereeCrudo) => {
  const n = normalizarArbitro(refereeCrudo);
  if (!n) return null;
  const cred = supabaseLectura();
  if (!cred) return null;

  const consulta = async (ruta) => {
    const r = await fetch(`${cred.url}/rest/v1/${ruta}`, {
      headers: cred.cabeceras,
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const filas = await r.json();
    if (!Array.isArray(filas)) throw new Error("respuesta no tabular");
    return filas;
  };

  try {
    const campos = "select=arbitro_clave,arbitro_display,amarillas,rojas";
    // (a) clave exacta
    let filas = await consulta(`arbitro_partidos?${campos}&arbitro_clave=eq.${encodeURIComponent(n.clave)}`);

    // (b) cruce del abreviado: "g pereira" → inicial "g" + apellido
    // "pereira", like anclado "g*pereira". Si las filas que casan
    // pertenecen a MAS de una clave distinta, no hay ficha.
    if (!filas.length && n.esAbreviado) {
      const partes = n.clave.split(" ");
      const inicial = partes[0].length === 1 ? partes[0] : null;
      const apellido = partes[partes.length - 1].length > 1 ? partes[partes.length - 1] : null;
      if (!inicial || !apellido) return null;
      const candidatas = await consulta(
        `arbitro_partidos?${campos}&arbitro_clave=like.${encodeURIComponent(`${inicial}*${apellido}`)}`
      );
      const claves = new Set(candidatas.map((x) => x.arbitro_clave));
      if (claves.size !== 1) return null;
      filas = candidatas;
    }

    // Promedios sobre filas CON dato de tarjetas (NULL = stats no
    // disponibles: fuera del numerador y del denominador).
    const medidos = filas.filter((x) => x.amarillas != null);
    if (medidos.length < MUESTRA_MINIMA_ARBITRO) return null;
    const amarillas = medidos.reduce((a, x) => a + x.amarillas, 0);
    const rojas = medidos.reduce((a, x) => a + (x.rojas ?? 0), 0);
    // El display mas largo suele ser la forma mas completa del nombre
    // (util cuando el fixture vino abreviado y la tabla tiene el completo).
    const display = filas.reduce((d, x) => ((x.arbitro_display || "").length > d.length ? x.arbitro_display : d), n.display);

    return {
      display,
      partidos: medidos.length,
      amarillas_prom: Number((amarillas / medidos.length).toFixed(1)),
      rojas_total: rojas,
    };
  } catch {
    return null;
  }
};

// (1/2) obtenerDatosPartido: el pipeline INTERNO completo — acepta nombres
// o fixture_id y devuelve { http, body }; lo envuelven el handler HTTP y
// obtenerDatosFixture. No es la entrada del cron.
// ── Pipeline completo del partido, exportado ──────────────────────────
// Toda la logica vive en esta funcion y el handler HTTP del final es un
// envoltorio fino; el cron importa obtenerDatosFixture() de este modulo.
// Frontera: el CLIENTE jamas importa este archivo — le habla por HTTP.
// Devuelve { http, body }: el mismo contrato que respondia el endpoint.
export async function obtenerDatosPartido({ local, visitante, fixture_id } = {}) {
  const respuesta = (http, body) => ({ http, body });
  const API_KEY = process.env.API_FOOTBALL_KEY;

  if (!API_KEY) {
    return respuesta(500, { error: "API_FOOTBALL_KEY no configurada" });
  }

  // ── Validación de entrada ─────────────────────────────────────────
  // Dos formas de pedir un partido:
  //   - por nombres, como siempre (el buscador)
  //   - por fixture_id, cuando ya se sabe cual es (el calendario). Ese
  //     camino se salta toda la resolucion de nombres, que es de donde
  //     salen las confusiones tipo "Aguilas" -> club español.
  const fixtureIdPedido = Number.isFinite(Number(fixture_id))
    ? Number(fixture_id)
    : null;

  const localNombre = typeof local === "string" ? local.trim() : "";
  const visitanteNombre = typeof visitante === "string" ? visitante.trim() : "";

  if (!fixtureIdPedido && (!localNombre || !visitanteNombre)) {
    return respuesta(400, {
      error:
        "Falta identificar el partido: envia 'fixture_id', o bien 'local' y 'visitante'",
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

    // ── 2. Localizar el partido ───────────────────────────────────────
    // Con fixture_id basta una peticion y el partido es exactamente el que
    // el usuario toco. Sin el, hay que resolver los dos nombres (2 peticiones
    // o mas) y luego buscar el proximo enfrentamiento entre ambos (1 mas).
    let match;

    if (fixtureIdPedido) {
      const d = await pedir(`/fixtures?id=${fixtureIdPedido}`);
      match = d.response?.[0];

      if (!match) {
        return respuesta(200, {
          ...vacio,
          mensaje: `El partido ${fixtureIdPedido} ya no existe en API-Football. Se usará búsqueda web como respaldo.`,
        });
      }
    } else {
      const [equipoLocal, equipoVisitante] = await Promise.all([
        buscarEquipo(localNombre),
        buscarEquipo(visitanteNombre),
      ]);

      if (!equipoLocal || !equipoVisitante) {
        const faltante = !equipoLocal ? localNombre : visitanteNombre;
        return respuesta(200, {
          ...vacio,
          mensaje: `Equipo no encontrado en API-Football: "${faltante}". Se usará búsqueda web como respaldo.`,
        });
      }

      // El parámetro `next` no está disponible en todos los planes, así que
      // se pide el historial completo y se elige aquí el primer partido
      // cuya fecha esté por delante de ahora.
      const h2hData = await pedir(
        `/fixtures/headtohead?h2h=${equipoLocal.id}-${equipoVisitante.id}`
      );
      const enfrentamientos = h2hData.response || [];

      const ahora = Date.now();
      match = enfrentamientos
        .filter((f) => {
          const t = new Date(f.fixture?.date).getTime();
          return Number.isFinite(t) && t > ahora;
        })
        .sort(
          (a, b) =>
            new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime()
        )[0];

      if (!match) {
        return respuesta(200, {
          ...vacio,
          mensaje: `No hay un próximo enfrentamiento programado entre ${equipoLocal.name} y ${equipoVisitante.name} (se revisaron ${enfrentamientos.length} enfrentamientos anteriores). Se usará búsqueda web como respaldo.`,
        });
      }
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

    // Tanda de 4 + pausa, y la 5a despues: la API corta rafagas de mas de 4
    // peticiones simultaneas (medido), y este Promise.all de 5 era la unica
    // rafaga que quedaba fuera de la regla — con clicks sueltos mordia poco,
    // en el bucle del cron morderia seguro.
    const [injuriesData, oddsData, statsHomeData, statsAwayData] =
      await Promise.all([
        // Lesionados del partido
        pedirOpcional(`/injuries?fixture=${fixtureId}`, "Lesionados"),
        // Cuotas. Se pide SIN filtro de bookmaker: una sola llamada trae las
        // ~14 casas que cotizan el partido (paging total 1) y de ahi se sacan
        // las dos que interesan, en vez de gastar una peticion por casa.
        pedirOpcional(`/odds?fixture=${fixtureId}`, "Cuotas"),
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
      ]);

    await dormir(250);

    // Segunda tanda (misma regla de 4): tabla de posiciones + ultimos
    // partidos de cada equipo (receta 6: el descanso MEDIDO — fecha del
    // ultimo jugado y copa entre semana — sale de aqui, 1 peticion por
    // equipo; last=3 devuelve los ultimos finalizados con su liga).
    const [standingsData, ultimosHomeData, ultimosAwayData] =
      await Promise.all([
        pedirOpcional(`/standings?league=${leagueId}&season=${season}`, "Tabla de posiciones"),
        pedirOpcional(`/fixtures?team=${homeTeamId}&last=3`, "Ultimos partidos del local"),
        pedirOpcional(`/fixtures?team=${awayTeamId}&last=3`, "Ultimos partidos del visitante"),
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

    // ── 5. Comparar cuotas de dos casas ───────────────────────────────
    // Betano acompaña a Bet365 porque cubre bastante mejor corners y
    // tarjetas en Sudamerica (en Colombia y Peru Bet365 directamente no
    // cotiza tarjetas). El criterio es conservador: ante dos precios para la
    // misma apuesta se usa el mas bajo, que es el que menos infla el EV.
    const CASAS = [
      { id: 8, nombre: "Bet365" },
      { id: 32, nombre: "Betano" },
    ];

    // Una cuota de 1.00 o menos no devuelve nada: es un mercado suspendido o
    // un precio roto. Pasa de verdad — Bet365 publica "Goals Over/Under -
    // Under 6.5" a 1 en varios partidos — y sin este filtro "la mas baja"
    // agarraria justo ese valor.
    const CUOTA_MIN = 1.01;
    const CUOTA_MAX = 1000;

    // Excepcion a "la mas baja": si la baja esta pegada al suelo y la otra
    // casa la desmiente por mucho, la rota es la baja. Umbrales medidos sobre
    // 2716 pares reales de estos dos libros: los 62 pares legitimos con cuota
    // baja por debajo de 1.10 no superan 1.068 de discrepancia, muy lejos del
    // 1.30 que exige la excepcion (0 falsos positivos en la muestra).
    const SUELO_SOSPECHOSO = 1.10;
    const DESVIO_MAX = 1.30;

    const cuotaValida = (o) => Number.isFinite(o) && o >= CUOTA_MIN && o <= CUOTA_MAX;

    const librosPorId = new Map(
      (oddsData?.response?.[0]?.bookmakers || []).map((b) => [b.id, b])
    );

    // Seleccion por id y NUNCA por posicion: el orden del array de casas
    // cambia de un partido a otro.
    const librosUsados = CASAS
      .map((c) => ({ ...c, libro: librosPorId.get(c.id) }))
      .filter((c) => c.libro);

    // mercado -> linea exacta -> candidatas de cada casa. El emparejado es
    // por mercado + linea: si Betano cotiza corners 8.5 y Bet365 solo 10.5,
    // cada linea va por su lado y no se mezclan.
    const mercados = new Map();
    for (const { nombre, libro } of librosUsados) {
      for (const bet of libro.bets || []) {
        if (!bet?.name) continue;
        const lineas = mercados.get(bet.name) || new Map();
        for (const v of bet.values || []) {
          if (v?.value == null) continue;
          const oddNum = parseFloat(v.odd);
          if (!cuotaValida(oddNum)) continue;
          const candidatas = lineas.get(v.value) || [];
          candidatas.push({ odd: v.odd, oddNum, casa: nombre });
          lineas.set(v.value, candidatas);
        }
        if (lineas.size) mercados.set(bet.name, lineas);
      }
    }

    const elegirCuota = (candidatas) => {
      if (candidatas.length === 1) return candidatas[0];
      const orden = [...candidatas].sort((a, b) => a.oddNum - b.oddNum);
      const baja = orden[0];
      const alta = orden[orden.length - 1];
      if (baja.oddNum < SUELO_SOSPECHOSO && alta.oddNum / baja.oddNum >= DESVIO_MAX) {
        return alta;
      }
      return baja;
    };

    // Mismo formato de siempre ({ mercado, valores: [{ value, odd }] }) para
    // no tocar a quien lo consume; `casa` y `comparada` se añaden encima.
    const odds = [...mercados.entries()].map(([mercado, lineas]) => ({
      mercado,
      valores: [...lineas.entries()].map(([value, candidatas]) => {
        const elegida = elegirCuota(candidatas);
        return {
          value,
          odd: elegida.odd,
          casa: elegida.casa,
          comparada: candidatas.length > 1,
        };
      }),
    }));

    // ── 5b. Linea sharp (receta 6): Pinnacle desde la MISMA respuesta ─
    // de /odds ya pagada — cero peticiones extra. Es VARA de probabilidad
    // (precio con poco margen), jamas ejecutable: las cuotas de arriba
    // siguen siendo Bet365/Betano. null si Pinnacle no cubre el partido o
    // ningun mercado clave — cobertura por medir, silencio honesto.
    const PINNACLE_ID = 4;
    const pinnacle = librosPorId.get(PINNACLE_ID);
    const sharpCrudo = pinnacle
      ? (pinnacle.bets || [])
          .filter((b) => b?.name && NOMBRES_MERCADOS_CLAVE.has(b.name))
          .map((b) => ({
            mercado: b.name,
            valores: (b.values || [])
              .filter((v) => v?.value != null && cuotaValida(parseFloat(v.odd)))
              .map((v) => ({ value: v.value, odd: v.odd })),
          }))
          .filter((b) => b.valores.length)
      : null;
    const linea_sharp = sharpCrudo && sharpCrudo.length ? sharpCrudo : null;

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
        // Desglose local/visitante (receta 6): la MISMA respuesta ya lo
        // traia y se descartaba. El recetario pinta casa para el local y
        // fuera para el visitante.
        casa: {
          jugados: s.fixtures?.played?.home,
          ganados: s.fixtures?.wins?.home,
          empatados: s.fixtures?.draws?.home,
          perdidos: s.fixtures?.loses?.home,
          goles_favor: s.goals?.for?.total?.home,
          goles_contra: s.goals?.against?.total?.home,
        },
        fuera: {
          jugados: s.fixtures?.played?.away,
          ganados: s.fixtures?.wins?.away,
          empatados: s.fixtures?.draws?.away,
          perdidos: s.fixtures?.loses?.away,
          goles_favor: s.goals?.for?.total?.away,
          goles_contra: s.goals?.against?.total?.away,
        },
        forma: s.form,
        mayor_racha_victorias: s.biggest?.streak?.wins,
        mayor_racha_derrotas: s.biggest?.streak?.loses,
        // El primer sumando tambien necesita el || 0: si la API no trae el
        // tramo 0-15 (undefined + n = NaN), la IA acababa leyendo
        // "Goles 1a parte:NaN".
        goles_primer_tiempo: (s.goals?.for?.minute?.["0-15"]?.total || 0) +
          (s.goals?.for?.minute?.["16-30"]?.total || 0) +
          (s.goals?.for?.minute?.["31-45"]?.total || 0),
      };
    };

    // ── 7. Posición en tabla ──────────────────────────────────────────
    // TRAMPA: standings devuelve VARIOS grupos en las ligas con etapas
    // (Colombia 2: Apertura+Clausura; Argentina 4: Apertura/Clausura x
    // Group A/B; Uruguay 5: Tabla Anual, Promedios, Intermedio, Apertura,
    // Clausura). Aplanar y tomar el primer hallazgo servia la tabla del
    // Apertura TERMINADO como vigente: Cucuta salia 19° "en descenso"
    // cuando iba 10° en el Clausura. La etapa correcta la nombra el propio
    // fixture en league.round ("Clausura - 8"): se elige el grupo que case
    // con ella, POR EQUIPO — en Argentina un interzonal cruza Group A con
    // Group B y cada equipo vive en su grupo.
    const grupos = standingsData?.response?.[0]?.league?.standings || [];
    const normalizarEtapa = (t) =>
      (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const roundActual = match.league?.round || "";
    const etapaRound = normalizarEtapa(roundActual.split(" - ")[0]);
    const fechaRound = (roundActual.split(" - ")[1] || "").trim();

    // Con un solo grupo no hay ambiguedad; con varios, solo los que casan
    // con la etapa del round.
    const gruposEtapa =
      grupos.length <= 1
        ? grupos
        : grupos.filter((g) => etapaRound && normalizarEtapa(g[0]?.group).includes(etapaRound));

    const buscarEnGrupos = (teamId) => {
      for (const g of gruposEtapa) {
        const t = g.find((x) => x.team?.id === teamId);
        if (t) return { ...t, grupo: g[0]?.group };
      }
      return null;
    };

    const posLocal = buscarEnGrupos(homeTeamId);
    const posVisit = buscarEnGrupos(awayTeamId);

    // Fallback NO silencioso: si ningun grupo casa con el round (playoffs,
    // finales, nombres raros) no se finge certeza con grupos[0] — el campo
    // `tabla` lo declara, las posiciones van vacias, y la IA no arma
    // narrativas de descenso o clasificacion sobre una tabla dudosa.
    const tabla = gruposEtapa.length
      ? `${posLocal?.grupo || posVisit?.grupo || gruposEtapa[0][0]?.group}${fechaRound ? ` (fecha ${fechaRound})` : ""}`
      : "sin etapa identificada: posiciones no aplican";

    // /teams/statistics solo filtra por season: cubre la temporada ENTERA
    // (en ligas con etapas, Apertura y Clausura sumados — verificado:
    // played.total de Tolima = 30 = sus 30 FT reales de 2026). Etiqueta
    // para la IA; el dato no se toca.
    const statsPeriodo = `temporada ${season} completa (todas las etapas sumadas)`;

    // ── 7b+7c. Altitud (receta 3) y ficha del arbitro (receta 5) ──────
    // Cualquier hueco (tablas sin sembrar, Supabase caido) queda en null:
    // silencio honesto, jamas se rompe. En PARALELO a proposito — son
    // independientes, y en un Supabase degradado el peor caso en serie
    // doblaria el presupuesto de pared dentro del timeout de Vercel.
    const [altitud, arbitro] = await Promise.all([
      leerAltitudes(homeTeamId, awayTeamId, match.fixture.venue?.id ?? null),
      leerArbitro(match.fixture.referee),
    ]);

    // ── 7d. Descanso medido (receta 6) ────────────────────────────────
    // Dias sin jugar y copa entre semana, deterministas desde los ultimos
    // partidos jugados. Los dias se miden contra el KICKOFF del fixture y
    // NO contra "ahora": un analisis pre-cocinado horas antes por el cron
    // debe decir lo mismo que uno generado al vuelo. null donde falten
    // fechas — silencio honesto (y la instruccion del prompt manda
    // puntuar neutro).
    const kickoffMs = new Date(match.fixture.date).getTime();
    // Solo partidos JUGADOS de verdad: `last=` puede colar pospuestos y
    // cancelados con fecha pasada (PST conserva la fecha original), y un
    // pospuesto contando como "jugado ayer" fabricaria fatiga falsa —
    // mismo filtro FT/AET/PEN que el resto del repo.
    const JUGADO_REAL = new Set(["FT", "AET", "PEN"]);
    // Copa entre semana: cuando el fixture analizado ES una continental
    // (Libertadores 13 / Sudamericana 11), el partido de LIGA del finde
    // NO es "copa" — sin esta guarda, el 100% de los analisis de copa
    // marcaria fatiga falsa a ambos equipos (liga domingo → copa
    // miercoles es el calendario NORMAL de la competicion).
    const CONTINENTALES = new Set([13, 11]);
    const descansoDe = (ultimos) => {
      if (!ultimos || !Number.isFinite(kickoffMs)) return null;
      const jugados = (ultimos.response || [])
        .filter((f) => JUGADO_REAL.has(f.fixture?.status?.short))
        .map((f) => ({ t: new Date(f.fixture?.date).getTime(), ligaId: f.league?.id }))
        .filter((x) => Number.isFinite(x.t) && x.t < kickoffMs)
        .sort((a, b) => b.t - a.t);
      if (!jugados.length) return null;
      return {
        dias: Math.floor((kickoffMs - jugados[0].t) / 86400000),
        jugo_copa_semana: jugados.some(
          (x) =>
            kickoffMs - x.t <= 4 * 86400000 &&
            x.ligaId !== leagueId &&
            (CONTINENTALES.has(x.ligaId) || !CONTINENTALES.has(leagueId))
        ),
      };
    };
    const descanso = {
      local: descansoDe(ultimosHomeData),
      visitante: descansoDe(ultimosAwayData),
    };

    return respuesta(200, {
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
      // Que tabla se esta usando (grupo + fecha del round) y que periodo
      // cubren las stats de equipo: cada analisis lo cita en vez de dejar
      // que la IA lo adivine.
      tabla,
      stats_periodo: statsPeriodo,
      altitud,
      arbitro,
      descanso,
      linea_sharp,
      posicion_local: posLocal
        ? { pos: posLocal.rank, pts: posLocal.points, forma: posLocal.form, grupo: posLocal.grupo }
        : null,
      posicion_visitante: posVisit
        ? { pos: posVisit.rank, pts: posVisit.points, forma: posVisit.form, grupo: posVisit.grupo }
        : null,
      // Bloques que la API rechazo. Si esto no esta vacio, los huecos
      // correspondientes son "no se pudo consultar", no "no hay nada".
      avisos,
      lesionados_disponibles: injuriesData !== null,
      cuotas_casas: librosUsados.map((c) => c.nombre),
    });
  } catch (error) {
    // Fallo identificado de la API (cuota, clave, plan, parametro). Se
    // responde 200 a proposito: el frontend solo lee el cuerpo cuando la
    // respuesta es ok, y aqui lo que importa es que el motivo real llegue
    // entero en vez de perderse tras un 5xx.
    if (error instanceof ErrorApiFootball) {
      return respuesta(200, {
        ...vacio,
        error_api: true,
        tipo_error: error.tipo,
        endpoint: error.endpoint,
        mensaje: `${error.message} Se usara busqueda web como respaldo.`,
      });
    }

    // Fallo no atribuible a la API (red caida, bug propio).
    return respuesta(500, {
      error: error.message,
      encontrado: false,
      error_api: false,
      tipo_error: "fallo_interno",
      mensaje: "Error consultando API-Football. Se usará búsqueda web como respaldo.",
    });
  }
}

// (2/2) obtenerDatosFixture: el export que importara el CRON — solo
// fixture_id, devuelve el payload pelado (sin envoltorio http).
export async function obtenerDatosFixture(fixtureId) {
  const { body } = await obtenerDatosPartido({ fixture_id: fixtureId });
  return body;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  // 401 ANTES de gastar cuota de API-Football.
  const usuario = await exigirSesion(req, res);
  if (!usuario) return;

  const { http, body } = await obtenerDatosPartido(req.body || {});
  return res.status(http).json(body);
}
