// ── Unica definicion de las ligas del producto ────────────────────────
// La importan api/fixtures.js (calendario) y el script del cron. Cero
// copias: la liga que se añada aqui aparece en ambos a la vez — una lista
// duplicada es como se olvida una liga en silencio.
//
// Orden de la lista = orden en pantalla. Colombia primero y el resto de
// Sudamerica, despues las 5 grandes europeas, y los torneos continentales al
// final. Las UEFA (Champions, Europa League, Conference) siguen en pausa
// hasta que la API cargue su fase principal.
//
// Ojo con Paraguay: el 250 (Apertura) esta muerto — su temporada cerro el
// 24-may-2026 y devuelve 0 partidos — pero la API lo sigue marcando como
// `current`. El vivo es el 252 (Clausura). Por eso las ligas se verifican por
// fechas reales y por que devuelvan fixtures, nunca por ese flag.
export const LIGAS = [
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
