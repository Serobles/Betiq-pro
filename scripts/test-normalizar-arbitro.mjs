#!/usr/bin/env node
// ── Tests del normalizador de arbitros (Recetario v2c, pieza 1) ───────
// Sin framework, como todo en la casa:
//   node scripts/test-normalizar-arbitro.mjs      (exit 1 si algo falla)
// Los literales son REALES, tal como llegaron en las sondas de arbitros
// (5-sep y 8-sep-2026): pais tras coma, iniciales, tildes, espacios.
import { normalizarArbitro } from "../api/_analysis.js";

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

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodos los casos pasan");
process.exit(fallos ? 1 : 0);
