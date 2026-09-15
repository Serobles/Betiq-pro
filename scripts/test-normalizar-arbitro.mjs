#!/usr/bin/env node
// ── Tests del normalizador de arbitros (Recetario v2c, pieza 1) ───────
// Sin framework, como todo en la casa:
//   node scripts/test-normalizar-arbitro.mjs      (exit 1 si algo falla)
// Los literales son REALES, tal como llegaron en las sondas de arbitros
// (5-sep y 8-sep-2026): pais tras coma, iniciales, tildes, espacios.
import { normalizarArbitro, agregarFichasArbitro } from "../api/_analysis.js";

const casos = [
  // [crudo, esperado]
  ["Wilmar Roldán, Colombia", { clave: "wilmar roldan", display: "Wilmar Roldán", esAbreviado: false }],
  ["Bruno Abatti", { clave: "bruno abatti", display: "Bruno Abatti", esAbreviado: false }],
  ["Jhon Ospina Echavarria, Colombia", { clave: "jhon ospina echavarria", display: "Jhon Ospina Echavarria", esAbreviado: false }],
  ["G. Pereira, Uruguay", { clave: "g pereira", display: "G. Pereira", esAbreviado: true }],
  ["Mario Diaz De Vivar, Paraguay", { clave: "mario diaz de vivar", display: "Mario Diaz De Vivar", esAbreviado: false }],
  ["  Facundo   Tello ", { clave: "facundo tello", display: "Facundo Tello", esAbreviado: false }],
  ["José Argote, Venezuela", { clave: "jose argote", display: "José Argote", esAbreviado: false }],
  // entradas vacias o rotas → null, silencio honesto
  ["", null],
  ["   ", null],
  [null, null],
  [undefined, null],
];

let fallos = 0;
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const [crudo, esperado] of casos) {
  const got = normalizarArbitro(crudo);
  const ok = igual(got, esperado);
  if (!ok) fallos++;
  console.log(`${ok ? "ok " : "FALLO"} ${JSON.stringify(crudo)} → ${JSON.stringify(got)}${ok ? "" : ` (esperaba ${JSON.stringify(esperado)})`}`);
}

// Caso CRUZADO documentado como NO resuelto aqui: el abreviado y el
// completo del mismo arbitro producen claves DISTINTAS a proposito — el
// cruce vive en la lectura (pieza 3) con la regla del candidato unico.
const abrev = normalizarArbitro("W. Roldan, Colombia");
const completo = normalizarArbitro("Wilmar Roldán, Colombia");
const cruzadoOk = abrev.clave !== completo.clave && abrev.esAbreviado && !completo.esAbreviado;
if (!cruzadoOk) fallos++;
console.log(`${cruzadoOk ? "ok " : "FALLO"} cruzado abreviado↔completo NO se fusiona al normalizar ("${abrev.clave}" ≠ "${completo.clave}")`);

// ── Agregacion de fichas (receta 7): los Herrera REALES de la tabla ───
// La familia (misma inicial+apellido) se agrega solo con candidato unico;
// dos completas distintas = dos personas = solo match exacto. Las filas
// que entrega cada caso son las que traeria el like inicial*apellido.
const fila = (clave, display, amarillas) => ({ arbitro_clave: clave, arbitro_display: display, amarillas, rojas: amarillas == null ? null : 0 });
const filasDe = (clave, display, n, amarillas) => Array.from({ length: n }, () => fila(clave, display, amarillas));

// Familia A: "A. Herrera" (28 medidas, ~4.2) + "Alexis Herrera" (1 con NULL)
const famA = [
  ...filasDe("a herrera", "A. Herrera", 14, 4),
  ...filasDe("a herrera", "A. Herrera", 14, 5),  // media ≈ 4.5 para el test
  fila("alexis herrera", "Alexis Herrera", null),
];
// Familia D: "D. Herrera" (8 medidas de 3) + "Dario Herrera" (23 de 5)
const famD = [
  ...filasDe("d herrera", "D. Herrera", 8, 3),
  ...filasDe("dario herrera", "Dario Herrera", 23, 5),
];
// Doble Roldan sintetico: DOS completas con misma inicial+apellido
const famRoldan = [
  ...filasDe("wilmar roldan", "Wilmar Roldán", 8, 5),
  ...filasDe("walter rodriguez roldan", "Walter Rodriguez Roldan", 6, 4),
];

const casosAgg = [
  // [nombre, entrante crudo, filas, esperado {partidos, display} o null]
  ["Alexis completo agrega con su abreviada", "Alexis Herrera, Venezuela", famA, { partidos: 28, display: "Alexis Herrera" }],
  ["A. Herrera abreviado agrega igual", "A. Herrera, Venezuela", famA, { partidos: 28, display: "Alexis Herrera" }],
  ["D. Herrera agrega con Dario (8+23)", "D. Herrera, Argentina", famD, { partidos: 31, display: "Dario Herrera" }],
  ["Dario agrega con D. (mismo total)", "Dario Herrera, Argentina", famD, { partidos: 31, display: "Dario Herrera" }],
  ["Y. Herrera va aparte (su familia es el)", "Y. Herrera, Venezuela", filasDe("y herrera", "Y. Herrera", 12, 4), { partidos: 12, display: "Y. Herrera" }],
  ["doble Roldan: W. Roldan sigue callando", "W. Roldan, Colombia", famRoldan, null],
  ["doble Roldan: Wilmar completo usa SOLO lo suyo", "Wilmar Roldán, Colombia", famRoldan, { partidos: 8, display: "Wilmar Roldán" }],
  ["ficha pobre sola (1 fila NULL) sigue callando", "Alexis Herrera, Venezuela", [fila("alexis herrera", "Alexis Herrera", null)], null],
  // Los dos agujeros que cazo la revision del 15-sep:
  // (1) un DEBUTANTE de nombre completo frente a otra completa distinta
  //     son dos personas — jamas hereda la ficha ajena;
  ["debutante completo NO hereda ficha ajena", "David Herrera, Colombia", famD, null],
  ["debutante vs abreviada+completa ajenas → null", "Yesid Herrera, Venezuela", [...filasDe("y herrera", "Y. Herrera", 12, 4), ...filasDe("yender herrera", "Yender Herrera", 10, 5)], null],
  // (2) una inicial INTERMEDIA es identidad completa: dos personas con
  //     inicial y apellido iguales no se funden ni derrotan al doble-Roldan.
  ["inicial intermedia cuenta como completa (no se funden)", "Wilmar Roldán, Colombia", [...filasDe("wilmar roldan", "Wilmar Roldán", 8, 5), ...filasDe("walter a roldan", "Walter A. Roldan", 7, 2)], { partidos: 8, display: "Wilmar Roldán" }],
  ["dos iniciales intermedias distintas → cada uno lo suyo", "Jose A. Perez, Chile", [...filasDe("jose a perez", "Jose A. Perez", 6, 6), ...filasDe("jose m perez", "Jose M. Perez", 6, 2)], { partidos: 6, display: "Jose A. Perez" }],
];

for (const [nombre, crudo, filas, esperado] of casosAgg) {
  const got = agregarFichasArbitro(normalizarArbitro(crudo), filas);
  const ok = esperado === null
    ? got === null
    : got && got.partidos === esperado.partidos && got.display === esperado.display;
  if (!ok) fallos++;
  console.log(`${ok ? "ok " : "FALLO"} ${nombre} → ${JSON.stringify(got && { partidos: got.partidos, prom: got.amarillas_prom, display: got.display })}`);
}

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodos los casos pasan");
process.exit(fallos ? 1 : 0);
