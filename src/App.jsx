import { useState, useEffect, useRef } from "react";
import { supabase, loginGoogle, loginFacebook, logout, getCachedAnalysis, saveAnalysisCache, checkAndIncrementAnalysis, yaVioFixture, marcarFixtureVisto, loadHistorialSupabase, saveHistorialSupabase, PLAN_LIMITS } from './supabase.js';
// Logica pura del analisis (prompt, searchData, parseo, normalizacion,
// posts): compartida con el cron via api/_analysis.js para que ambos
// produzcan EXACTAMENTE el mismo JSON cacheado.
import { SYSTEM_PROMPT, construirSearchData, searchDataSinDatos, construirMensajeUsuario, parsearRespuestaAnalisis, normalizarAnalisis, adjuntarPosts } from "../api/_analysis.js";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis, Legend,
  LineChart, Line
} from "recharts";

// ── Modo: si el hostname es betiq-pro-pearl → app usuario (sin Post) ──
const IS_USER_MODE = typeof window !== "undefined" && (
  window.location.hostname.includes("betiq-pro-pearl") ||
  new URLSearchParams(window.location.search || "").get("mode") === "user"
);

const C = {
  bg:       "#0d1b2a",
  card:     "#162436",
  card2:    "#1c2e44",
  card3:    "#22384f",
  border:   "#2a4060",
  accent:   "#22c55e",
  accentDim:"#14532d",
  green:    "#4ade80",
  greenDim: "#14532d",
  red:      "#f87171",
  redDim:   "#4c0519",
  amber:    "#fbbf24",
  amberDim: "#422006",
  blue:     "#60a5fa",
  purple:   "#c084fc",
  text:     "#e2f0fb",
  muted:    "#7eb8d4",
  dim:      "#4a7090",
};

// El icono se elige por el TIPO de mercado, nunca por la linea numerica.
// La IA genera el nombre con la linea real del partido ("Corners Over 8.5",
// "Goles Over 2.5"), asi que una tabla con la linea fija dentro de la clave
// ("Córners +9.5") no casaba con nada y todo salia con el 📌 generico.
// Se busca la palabra clave del mercado y las lineas dan igual.
//
// El orden IMPORTA: se aplica la primera regla que casa. Los mercados con
// sustantivo propio (corners, tarjetas) van antes que los genericos, porque
// "Corners Over 8.5" tambien contiene "over" y si no seria una flecha.
const MERCADOS_ICONS = [
  [/corner|esquina/,                  "🚩"],
  [/tarjeta|card/,                    "🟨"],
  [/handicap|hcp/,                    "⚖️"],
  [/ambos marcan|btts/,               "⚽"],
  [/doble oportunidad/,               "🔄"],
  [/draw no bet|empate no bet/,       "🛡️"],
  [/ht ?.? ?ft|descanso.*final/,      "📊"],
  [/descanso|medio tiempo|primera parte|primer tiempo/, "🕐"],
  [/primer gol|marca primero/,        "⚡"],
  // Under antes que over: "Goles Under 2.5" lleva flecha hacia abajo.
  [/\bunder\b|menos de/,              "📉"],
  [/\bover\b|mas de|\bgoles?\b/,      "📈"],
  [/1x2|victoria|gana|ganador/,       "🏆"],
];

const iconoMercado = (nombre) => {
  const n = (nombre || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!n) return "📌";
  return MERCADOS_ICONS.find(([re]) => re.test(n))?.[1] || "📌";
};


// ── Calcular stake sugerido según EV y confianza ──────────────────────
const calcStake = (ev, confianza) => {
  const e = parseFloat(ev) || 0;
  const c = parseFloat(confianza) || 0;
  if (e >= 0.15 && c >= 70) return { pct: 4.0, label: "ALTO",   color: "#04e872", desc: "Confianza máxima" };
  if (e >= 0.10 && c >= 60) return { pct: 3.0, label: "MEDIO",  color: "#22c55e", desc: "Buena confianza" };
  if (e >= 0.05 && c >= 50) return { pct: 2.0, label: "NORMAL", color: "#f59e0b", desc: "Confianza moderada" };
  return                          { pct: 1.5, label: "BAJO",   color: "#f87171", desc: "Apuesta cautelosa" };
};

const PIE_COLORS = ["#10b981", "#f59e0b", "#ef4444"];

function Badge({ children, color = C.accent, size = "sm" }) {
  return (
    <span style={{
      background: color + "22", color, border: `1px solid ${color}44`,
      borderRadius: 4, padding: size === "sm" ? "2px 8px" : "4px 12px",
      fontSize: size === "sm" ? 11 : 13, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase"
    }}>{children}</span>
  );
}

function RiskBadge({ risk }) {
  const map = { BAJO: [C.green, "🟢"], MEDIO: [C.accent, "🟡"], ALTO: [C.red, "🔴"] };
  const [c, icon] = map[risk] || [C.muted, "⚪"];
  return <Badge color={c}>{icon} riesgo {risk}</Badge>;
}

function EVBar({ ev }) {
  const pct = Math.min(Math.max(ev * 100, 0), 30);
  const color = ev > 0.1 ? C.green : ev > 0.05 ? C.accent : C.muted;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${(pct / 30) * 100}%`, background: color, borderRadius: 3, transition: "width .5s" }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 44 }}>+{(ev * 100).toFixed(1)}%</span>
    </div>
  );
}

function ScoreBar({ local, visitante }) {
  const lPct = (local / 10) * 100;
  const vPct = (visitante / 10) * 100;
  const winner = local > visitante ? "local" : visitante > local ? "visitante" : "empate";
  return (
    <div style={{ display: "flex", gap: 2, height: 6, borderRadius: 3, overflow: "hidden" }}>
      <div style={{ flex: 1, background: C.border, borderRadius: "3px 0 0 3px", position: "relative" }}>
        <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${lPct}%`, background: winner === "local" ? C.green : C.blue, borderRadius: "3px 0 0 3px" }} />
      </div>
      <div style={{ flex: 1, background: C.border, borderRadius: "0 3px 3px 0", position: "relative" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${vPct}%`, background: winner === "visitante" ? C.accent : "#c2410c", borderRadius: "0 3px 3px 0" }} />
      </div>
    </div>
  );
}

function MercadoCard({ m, partido, rank, bank = 0, onGuardar, guardadoId }) {
  const [guardado, setGuardado] = useState(false);
  const rankColors = { 1: C.accent, 2: C.blue, 3: C.dim };
  const rankLabels = { 1: "🥇 MEJOR VALOR", 2: "🥈 OPCIÓN 2", 3: "🥉 OPCIÓN 3" };
  return (
    <div style={{
      background: m.recomendado ? `linear-gradient(135deg, ${C.card2}, #0f2027)` : C.card2,
      border: `1px solid ${m.recomendado ? C.accent + "66" : C.border}`,
      borderRadius: 12, padding: "16px 18px", position: "relative", overflow: "hidden"
    }}>
      {m.recomendado && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: rankColors[rank] }} />}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: rankColors[rank] || C.dim, fontWeight: 700, marginBottom: 4 }}>{rankLabels[rank] || ""}</div>
          <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{iconoMercado(m.nombre)} {m.nombre}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{m.descripcion}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: C.accent, lineHeight: 1 }}>x{m.cuota?.toFixed(2)}</div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{m.cuota_fuente}</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
        {[
          { l: "Prob. real", v: `${m.prob_real}%`, c: C.green },
          { l: "Prob. implícita", v: `${m.prob_implicita}%`, c: C.muted },
          { l: "Confianza", v: `${m.nivel_confianza}%`, c: C.blue },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ background: C.card3, borderRadius: 7, padding: "8px", textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: c }}>{v}</div>
            <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 4 }}>Valor Esperado (EV)</div>
        <EVBar ev={m.ev} />
      </div>
      <div style={{ fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 6, lineHeight: 1.6 }}>
        {m.razon}
      </div>
      {/* Stake inline por mercado */}
      {bank > 0 && (() => {
        const sk = calcStake(m.ev, m.nivel_confianza);
        const monto = ((bank * sk.pct) / 100).toFixed(2);
        return (
          <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center", background: `${sk.color}11`, border: `1px solid ${sk.color}33`, borderRadius: 6, padding: "6px 10px" }}>
            <span style={{ fontSize: 11, color: sk.color, fontWeight: 700 }}>💰 Stake: {sk.pct}%</span>
            <span style={{ fontSize: 13, color: sk.color, fontWeight: 900 }}>${monto}</span>
          </div>
        );
      })()}

      {/* Botón guardar en historial */}
      {onGuardar && (
        <button
          onClick={() => { onGuardar(m); setGuardado(true); }}
          style={{
            marginTop: 12, width: "100%", padding: "9px",
            background: guardado ? "#14532d" : "linear-gradient(135deg,#16a34a,#22c55e)",
            color: "#fff", border: "none", borderRadius: 8,
            fontWeight: 700, fontSize: 13, cursor: guardado ? "default" : "pointer",
            opacity: guardado ? 0.85 : 1,
            boxShadow: guardado ? "none" : "0 2px 10px rgba(34,197,94,0.3)",
            transition: "all .2s"
          }}
        >
          {guardado ? "✅ Guardado en Historial" : "💾 Guardar esta apuesta en Historial"}
        </button>
      )}
    </div>
  );
}

function BajaCard({ b }) {
  const posIcons = { GK: "🧤", DC: "🛡️", LAT: "🏃", MCD: "⚙️", MC: "🔄", EXT: "⚡", DEL: "⚽" };
  const estadoColor = { Lesionado: C.red, Suspendido: C.accent, Duda: C.purple, Vacaciones: C.muted };
  return (
    <div style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{posIcons[b.posicion] || "👤"} {b.nombre}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {b.posicion} · {b.titular_habitual ? <span style={{ color: C.green }}>Titular habitual</span> : <span style={{ color: C.dim }}>Suplente</span>}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: estadoColor[b.estado] || C.muted }}>{b.estado}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: b.impacto === "Alto" ? C.red : b.impacto === "Medio" ? C.accent : C.green, background: (b.impacto === "Alto" ? C.redDim : b.impacto === "Medio" ? C.accent + "22" : C.greenDim) + "44", padding: "1px 6px", borderRadius: 3 }}>{b.impacto}</span>
        </div>
      </div>
      {b.detalle && <div style={{ fontSize: 11, color: C.dim, marginTop: 6, fontStyle: "italic" }}>{b.detalle}</div>}
    </div>
  );
}

// ─── HISTORIAL ESTILO FINTECH ────────────────────────────────────────────────
const CATEGORIAS = [
  { id: "free",    label: "IA Free",    icon: "💵", color: "#22c55e", bg: "#14532d" },
  { id: "premium", label: "IA Premium", icon: "💰", color: "#60a5fa", bg: "#1e3a5f" },
  { id: "vip",     label: "Grupo VIP",  icon: "💎", color: "#c084fc", bg: "#3b1f5e" },
];
const CAT = Object.fromEntries(CATEGORIAS.map(c => [c.id, c]));

function TransaccionCard({ r, onResult, onDelete, onUpdateField, records, save }) {
  const [expanded, setExpanded] = useState(false);
  const cuota  = r.cuota_jugada || r.cuota_1 || 0;
  const monto  = parseFloat(r.monto_apostado) || 0;
  const gan    = r.resultado === "GANADA"  ? monto * (cuota - 1)
               : r.resultado === "PERDIDA" ? -monto
               : r.resultado === "ANULADA" ? 0 : null;
  const cat    = CAT[r.categoria] || CAT.premium;
  const isPos  = gan > 0;
  const isNeg  = gan < 0;
  const amtColor = isPos ? "#10B981" : isNeg ? "#EF4444" : C.muted;
  const amtStr   = gan !== null
    ? `${gan >= 0 ? "+" : ""}$${Math.abs(gan).toFixed(2)}`
    : r.resultado === "PENDIENTE" ? "Pendiente" : "—";

  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      {/* Fila principal */}
      <div onClick={() => setExpanded(e => !e)} style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px", cursor:"pointer", background: expanded ? C.card2 : "transparent", transition:"background .15s" }}>
        {/* Icono categoría */}
        <div style={{ width:44, height:44, borderRadius:12, background:cat.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>
          {cat.icon}
        </div>
        {/* Info */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <span style={{ fontWeight:700, fontSize:14, color:C.text }}>{cat.label}</span>
            <span style={{ fontWeight:800, fontSize:15, color:amtColor, flexShrink:0, marginLeft:8 }}>{amtStr}</span>
          </div>
          <div style={{ fontSize:12, color:C.muted, marginTop:2, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
            {r.partido || `${r.local||""} vs ${r.visitante||""}`}
          </div>
          <div style={{ display:"flex", gap:8, marginTop:4, alignItems:"center" }}>
            {r.fecha_partido && <span style={{ fontSize:10, color:C.dim }}>{r.fecha_partido}</span>}
            {cuota > 0 && <span style={{ fontSize:11, color:cat.color, fontWeight:700 }}>#{cuota.toFixed(2)}</span>}
            <span style={{ fontSize:10, fontWeight:700, color: r.resultado==="GANADA"?"#10B981":r.resultado==="PERDIDA"?"#EF4444":r.resultado==="ANULADA"?"#6B7280":"#F59E0B" }}>
              {r.resultado==="PENDIENTE" ? "⏳" : r.resultado==="GANADA" ? "✅" : r.resultado==="PERDIDA" ? "❌" : "🚫"} {r.resultado||"PENDIENTE"}
            </span>
          </div>
        </div>
        <div style={{ color:C.dim, fontSize:12, flexShrink:0 }}>{expanded ? "▲" : "▶"}</div>
      </div>

      {/* Panel expandido */}
      {expanded && (
        <div style={{ background:C.card2, padding:"14px 16px 16px", borderTop:`1px solid ${C.border}` }}>
          {/* Mercado jugado */}
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:C.dim, marginBottom:4 }}>Apuesta jugada</div>
            <div style={{ fontWeight:600, fontSize:13, color:C.text }}>{r.apuesta_jugada || r.mercado_1 || "—"}</div>
            {r.desc_1 && <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{r.desc_1}</div>}
          </div>

          {/* Selector categoría */}
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:C.dim, marginBottom:6 }}>Categoría</div>
            <div style={{ display:"flex", gap:6 }}>
              {CATEGORIAS.map(c => (
                <button key={c.id} onClick={async e => { e.stopPropagation(); const u=records.map(rec=>rec.id!==r.id?rec:{...rec,categoria:c.id}); await save(u); }}
                  style={{ flex:1, padding:"6px 4px", borderRadius:8, border:`1.5px solid ${r.categoria===c.id?c.color:C.border}`, background:r.categoria===c.id?c.bg:"transparent", cursor:"pointer", fontSize:11, fontWeight:700, color:r.categoria===c.id?c.color:C.muted }}>
                  {c.icon} {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Selector mercado jugado */}
          {r.mercado_2 && r.mercado_2 !== "—" && r.resultado === "PENDIENTE" && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:11, color:C.dim, marginBottom:6 }}>¿Cuál mercado jugaste?</div>
              <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                {[{key:r.mercado_1,cuota:r.cuota_1},{key:r.mercado_2,cuota:r.cuota_2},{key:r.mercado_3,cuota:r.cuota_3}]
                  .filter(m=>m.key&&m.key!=="—")
                  .map((m,i)=>(
                    <button key={m.key} onClick={async e=>{ e.stopPropagation(); const u=records.map(rec=>rec.id!==r.id?rec:{...rec,apuesta_jugada:m.key,cuota_jugada:m.cuota}); await save(u); }}
                      style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 10px", borderRadius:6, border:`1px solid ${r.apuesta_jugada===m.key?C.accent:C.border}`, background:r.apuesta_jugada===m.key?C.accent+"22":"transparent", cursor:"pointer" }}>
                      <span style={{ fontSize:12, color:r.apuesta_jugada===m.key?C.accent:C.muted }}>#{i+1} {m.key}</span>
                      <span style={{ fontSize:13, fontWeight:700, color:C.accent }}>x{(m.cuota||0).toFixed(2)}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {/* Monto apostado */}
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
            <span style={{ fontSize:11, color:C.dim, whiteSpace:"nowrap" }}>Monto apostado</span>
            <div style={{ position:"relative", flex:1, maxWidth:140 }}>
              <span style={{ position:"absolute", left:8, top:"50%", transform:"translateY(-50%)", fontSize:12, color:C.muted }}>$</span>
              <input type="number" step="0.01" min="0" value={r.monto_apostado||""} placeholder="0.00"
                onClick={e=>e.stopPropagation()}
                onChange={async e=>{ const u=records.map(rec=>rec.id!==r.id?rec:{...rec,monto_apostado:e.target.value}); await save(u); }}
                style={{ background:C.card3, border:`1px solid ${C.border}`, borderRadius:6, padding:"5px 8px 5px 20px", color:C.text, fontSize:12, width:"100%", outline:"none", boxSizing:"border-box", fontFamily:"inherit" }} />
            </div>
            {gan !== null && monto > 0 && (
              <span style={{ fontSize:14, fontWeight:800, color:amtColor }}>{amtStr}</span>
            )}
          </div>

          {/* Botones resultado */}
          {r.resultado === "PENDIENTE" ? (
            <div style={{ display:"flex", gap:6 }}>
              <span style={{ fontSize:11, color:C.dim, alignSelf:"center", marginRight:4 }}>Resultado:</span>
              {[["GANADA","✅ Ganó","#10B981","#052e16"],["PERDIDA","❌ Perdió","#EF4444","#450a0a"],["ANULADA","🚫 Anulada","#6B7280","#1f2937"]].map(([res,label,col,bg])=>(
                <button key={res} onClick={e=>{ e.stopPropagation(); onResult(r.id,res); }}
                  style={{ flex:1, padding:"7px 4px", borderRadius:7, border:`1px solid ${col}`, background:bg, color:col, fontSize:11, fontWeight:700, cursor:"pointer" }}>{label}</button>
              ))}
            </div>
          ) : (
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <span style={{ fontSize:13, fontWeight:700, color:amtColor }}>{r.resultado} {amtStr}</span>
              <button onClick={e=>{ e.stopPropagation(); onResult(r.id,"PENDIENTE"); }}
                style={{ marginLeft:"auto", background:"transparent", border:`1px solid ${C.border}`, color:C.dim, borderRadius:5, padding:"3px 10px", fontSize:10, cursor:"pointer" }}>↩ Revertir</button>
              <button onClick={e=>{ e.stopPropagation(); onDelete(r.id); }}
                style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.dim, borderRadius:5, padding:"3px 8px", fontSize:10, cursor:"pointer" }}>🗑</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Calendario de partidos ────────────────────────────────────────────
// Lista de 5 dias (anteayer .. pasado manana) en la hora local del usuario.
// La zona sale del navegador y se le pasa a la API, que es quien agrupa por
// dia: agrupar por UTC mandaria los partidos nocturnos sudamericanos al dia
// siguiente.
const ZONA_NAVEGADOR =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// Estados que devuelve API-Football, agrupados por como se pintan. Los
// codigos salen de un barrido real: en una sola jornada aparecen NS, FT,
// 1H, HT, 2H, PST, CANC y AWD.
const FINALIZADO = new Set(["FT", "AET", "PEN"]);
const EN_JUEGO = new Set(["1H", "HT", "2H", "ET", "BT", "P"]);
const PROGRAMADO = new Set(["NS", "TBD"]);
const SIN_JUGARSE = { PST: "Aplazado", CANC: "Cancelado", AWD: "Perdida tecnica" };

const VENTANA_MS = 24 * 60 * 60 * 1000;
const BLOQUEADO_TITULO = "Disponible 24 horas antes";
const BLOQUEADO_TEXTO =
  "Nuestra IA analiza cada partido con toda la informacion disponible de ambos equipos, verificando y explorando las mejores cuotas posibles para entregarte el pronostico mas profesional.";

// Un mismo criterio para la tarjeta y para el pie de la seccion: si se
// calculara en dos sitios podrian acabar diciendo cosas distintas.
// Id de ancla estable para la seccion de una liga ("Perú · Primera División"
// -> "peru-primera-division"). Lo usan la cabecera en el calendario y el
// panel lateral de la vista de analisis.
const slugLiga = (nombre) =>
  (nombre || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-");

const estaBloqueado = (p) =>
  PROGRAMADO.has(p.estado) && p.timestamp * 1000 - Date.now() > VENTANA_MS;

const chipS = {
  fontSize: 11, fontWeight: 700, color: C.muted, background: C.card2,
  border: `1px solid ${C.border}`, borderRadius: 999, padding: "3px 9px", whiteSpace: "nowrap",
};

const PartidoFila = ({ p, onAnalizar, analizando }) => {
  const marcador = `${p.goles_local ?? "-"} - ${p.goles_visitante ?? "-"}`;

  let derecha = null;

  if (FINALIZADO.has(p.estado)) {
    derecha = <span style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{marcador}</span>;
  } else if (EN_JUEGO.has(p.estado)) {
    derecha = (
      <span style={{ fontSize: 14, fontWeight: 800, color: C.green, whiteSpace: "nowrap" }}>
        {marcador}
        <span style={{ fontSize: 11, color: C.accent, marginLeft: 6 }}>
          {p.minuto != null ? `${p.minuto}'` : "en juego"}
        </span>
      </span>
    );
  } else if (SIN_JUGARSE[p.estado]) {
    derecha = <span style={chipS}>{SIN_JUGARSE[p.estado]}</span>;
  } else if (PROGRAMADO.has(p.estado)) {
    // Bloqueado: solo el titulo. La explicacion va una vez al pie de la
    // seccion, no repetida en cada tarjeta.
    derecha = estaBloqueado(p) ? (
      <span style={chipS}>🔒 {BLOQUEADO_TITULO}</span>
    ) : (
      <button
        onClick={() => onAnalizar?.(p)}
        disabled={analizando}
        style={{
          fontSize: 12, fontWeight: 800, color: "#fff", border: "none", borderRadius: 8,
          padding: "7px 12px", whiteSpace: "nowrap",
          cursor: analizando ? "wait" : "pointer",
          background: analizando ? C.dim : "linear-gradient(135deg,#16a34a,#22c55e)",
        }}
      >
        {analizando ? "Analizando..." : "Ver analisis"}
      </button>
    );
  } else {
    // Cualquier codigo no contemplado se muestra tal cual en vez de colarse
    // por la rama de "programado" y acabar con un boton que no toca.
    derecha = <span style={chipS}>{p.estado}</span>;
  }

  return (
    <div id={`partido-${p.id}`} style={{ padding: "6px 2px 6px 10px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "52px 1fr auto", gap: 10, alignItems: "center" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>{p.hora}</span>
        <div style={{ fontSize: 13, color: C.text }}>
          <span style={{ fontWeight: p.gana_local ? 800 : 400 }}>{p.local}</span>
          <span style={{ color: C.dim }}> vs </span>
          <span style={{ fontWeight: p.gana_visitante ? 800 : 400 }}>{p.visitante}</span>
        </div>
        {derecha}
      </div>
    </div>
  );
};

const Calendario = ({ onAnalizar, analizandoId, diaSel, onDiaSel, objetivoScroll, onObjetivoCumplido, onLigasPorDia }) => {
  const [dias, setDias] = useState(null);
  // Ligas que no respondieron. Sin esto desapareceran de la lista en silencio
  // y pareceria que ese dia no tienen partidos.
  const [ligasCaidas, setLigasCaidas] = useState([]);
  const pestanaActiva = useRef(null);
  const [zona, setZona] = useState(ZONA_NAVEGADOR);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const r = await fetch("/api/fixtures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timezone: ZONA_NAVEGADOR }),
        });
        const txt = await r.text();
        if (txt.trimStart().startsWith("<")) throw new Error("sin backend");
        const d = JSON.parse(txt);
        if (!vivo) return;
        if (d.mensaje || d.error) setError(d.mensaje || d.error);
        else {
          setDias(d.dias);
          setZona(d.zona_horaria);
          setLigasCaidas(d.avisos || []);
          // Copia ligera para el padre (menu ☰): nombres de liga por dia.
          // Sobrevive al desmontaje de este componente (historial, analisis).
          onLigasPorDia?.((d.dias || []).map((x) => x.ligas.map((l) => l.liga)));
        }
      } catch {
        if (vivo) setError("No se pudo cargar el calendario.");
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, []);

  // El dia llega como "2026-08-22". Se formatea anclado a mediodia UTC para
  // que ninguna zona lo desplace al dia de al lado.
  // Las fechas llegan como "2026-08-23". Se anclan a mediodia UTC para que
  // ninguna zona las desplace al dia de al lado al formatearlas.
  const enUTC = (fecha, opts) =>
    new Intl.DateTimeFormat("es", { timeZone: "UTC", ...opts })
      .format(new Date(`${fecha}T12:00:00Z`));

  const diaCorto = (fecha) => enUTC(fecha, { weekday: "short" }).replace(".", "").toUpperCase();
  const fechaCorta = (fecha) => enUTC(fecha, { day: "numeric", month: "short" }).replace(".", "");

  // Solo importa lo que se esta viendo: la explicacion del bloqueo se pinta si
  // hay tarjetas bloqueadas en el dia elegido, no en cualquiera de los cinco.
  const visible = (dias || [])[diaSel];
  const hayBloqueados = Boolean(
    visible && visible.ligas.some((g) => g.partidos.some(estaBloqueado))
  );

  // Con 5 pestanas en un telefono, "hoy" nace fuera de pantalla. Se centra.
  useEffect(() => {
    pestanaActiva.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [diaSel, dias]);

  // 3C: al volver de la vista de analisis, situar la pantalla en la tarjeta
  // del partido que se toco. Corre cuando los dias ya estan pintados (con el
  // cache del servidor llegan casi al instante) y se consume SIEMPRE, aunque
  // la tarjeta ya no exista: un objetivo rancio no debe re-desplazar la
  // pantalla al cambiar de pestana mas tarde.
  useEffect(() => {
    if (!objetivoScroll || !dias) return;
    // Una tarjeta se centra; una seccion de liga se pone arriba, para que
    // debajo se vean sus partidos y no media pantalla de la liga anterior.
    document.getElementById(objetivoScroll)?.scrollIntoView({
      block: objetivoScroll.startsWith("liga-") ? "start" : "center",
    });
    onObjetivoCumplido?.();
  }, [dias, objetivoScroll]);

  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "24px", marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 18, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: C.accent }}>📅 Calendario de partidos</div>
        <div style={{ fontSize: 11, color: C.dim }}>Hora local · {zona}</div>
      </div>

      {cargando && <div style={{ fontSize: 13, color: C.muted }}>Cargando partidos...</div>}

      {!cargando && error && (
        <div style={{ fontSize: 13, color: C.amber, background: C.amberDim, border: `1px solid ${C.amber}55`, borderRadius: 8, padding: "10px 14px" }}>
          ⚠️ {error}
        </div>
      )}

      {!cargando && !error && ligasCaidas.length > 0 && (
        // Discreto a proposito: cuando esto se pinta, la liga ya fallo dos
        // veces (carga + reintento del servidor). Es un dato util, no una
        // alarma, y el resto del calendario esta bien.
        <div style={{
          marginBottom: 14, fontSize: 12, borderRadius: 8, padding: "9px 12px",
          color: C.muted, background: C.card2, border: `1px solid ${C.border}`,
        }}>
          {ligasCaidas.length === 1
            ? `${ligasCaidas[0].split(":")[0]} no está disponible en este momento`
            : `Estas ligas no están disponibles en este momento: ${ligasCaidas.map((a) => a.split(":")[0]).join(", ")}`}
        </div>
      )}

      {!cargando && !error && dias && (
        <>
          {/* Fila de dias. Se desliza a lo ancho: en un telefono las 5
              pestanas no caben, y comprimirlas las dejaria ilegibles. */}
          {/* Las medidas van en CSS y no inline porque cambian por ancho de
              pantalla: amplias en escritorio, contenidas en movil para que la
              fila siga deslizandose. El centrado es con margin:auto en los
              extremos, no con justify-content:center — ese recorta el borde
              izquierdo cuando la fila desborda y las primeras pestanas quedan
              inalcanzables. margin:auto centra cuando sobra sitio y se anula
              solo al desbordar. */}
          <style>{`
            .cal-dias::-webkit-scrollbar { display: none; }
            .cal-dias .cal-dia:first-child { margin-left: auto; }
            .cal-dias .cal-dia:last-child { margin-right: auto; }
            .cal-dia { min-width: 84px; padding: 9px 12px; }
            .cal-dia-nombre { font-size: 12px; }
            .cal-dia-fecha { font-size: 13px; }
            @media (min-width: 768px) {
              .cal-dia { min-width: 112px; padding: 12px 18px; }
              .cal-dia-nombre { font-size: 13px; }
              .cal-dia-fecha { font-size: 15px; }
            }
          `}</style>
          <div
            className="cal-dias"
            style={{
              display: "flex", gap: 8, overflowX: "auto", scrollbarWidth: "none",
              WebkitOverflowScrolling: "touch",
              borderBottom: `1px solid ${C.border}`,
              paddingBottom: 10, marginBottom: 14,
            }}
          >
            {dias.map((d, i) => {
              const activa = i === diaSel;
              const hoy = i === 2;
              return (
                <button
                  key={d.fecha}
                  ref={activa ? pestanaActiva : null}
                  onClick={() => onDiaSel(i)}
                  className="cal-dia"
                  style={{
                    flex: "0 0 auto",
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                    borderRadius: 9, cursor: "pointer",
                    background: activa ? "linear-gradient(135deg,#16a34a,#22c55e)" : C.card2,
                    border: `1px solid ${activa ? "#22c55e" : C.border}`,
                    color: activa ? "#fff" : C.muted,
                  }}
                >
                  <span className="cal-dia-nombre" style={{ fontWeight: 800, letterSpacing: ".04em", whiteSpace: "nowrap" }}>
                    {hoy ? "HOY" : diaCorto(d.fecha)}
                  </span>
                  <span className="cal-dia-fecha" style={{ fontWeight: 600, whiteSpace: "nowrap", opacity: activa ? 0.95 : 0.8 }}>
                    {fechaCorta(d.fecha)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Solo el dia elegido. El agrupado por liga y las tarjetas no
              cambian: lo unico nuevo es que se filtra a un dia a la vez. */}
          {visible && visible.ligas.length === 0 ? (
            <div style={{ fontSize: 12, color: C.dim, padding: "6px 2px" }}>No hay partidos</div>
          ) : (
            (visible?.ligas || []).map((g) => (
              <div key={g.liga} id={`liga-${slugLiga(g.liga)}`} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, padding: "4px 2px" }}>{g.liga}</div>
                {g.partidos.map((p) => (
                  <PartidoFila
                    key={p.id}
                    p={p}
                    // Junto al partido viajan las ligas del dia visible: el
                    // panel lateral de la vista de analisis las lista.
                    onAnalizar={(pp) => onAnalizar(pp, visible.ligas.map((x) => x.liga))}
                    analizando={analizandoId === p.id}
                  />
                ))}
              </div>
            ))
          )}
        </>
      )}

      {/* La explicacion del bloqueo va aqui, una sola vez, y solo si hay
          alguna tarjeta bloqueada a la vista. */}
      {!cargando && !error && hayBloqueados && (
        <div style={{
          marginTop: 16, paddingTop: 12, borderTop: `1px solid ${C.border}`,
          fontSize: 11, color: C.dim, lineHeight: 1.5,
        }}>
          🔒 {BLOQUEADO_TEXTO}
        </div>
      )}
    </div>
  );
};

function Historial() {
  const [records, setRecords]   = useState([]);
  const [loaded, setLoaded]     = useState(false);
  const [filtro, setFiltro]     = useState("TODOS");
  const [exporting, setExporting] = useState(false);
  const [showAdd, setShowAdd]   = useState(false);
  const [form, setForm]         = useState({ partido:"", mercado:"", cuota:"", resultado:"PENDIENTE", fecha:"", categoria:"premium" });

  const loadFromStorage = () => {
    try {
      const r = localStorage.getItem("betscore_historial");
      if (r) {
        const parsed = JSON.parse(r);
        // Ordenar siempre por id desc (más reciente primero)
        parsed.sort((a, b) => (b.id || 0) - (a.id || 0));
        setRecords(parsed);
      } else setRecords([]);
    } catch { setRecords([]); }
    setLoaded(true);
  };

  useEffect(() => {
    loadFromStorage();
    window.addEventListener("storage", loadFromStorage);
    return () => window.removeEventListener("storage", loadFromStorage);
  }, []);

  const save = async (newRecs) => {
    const sorted = [...newRecs].sort((a, b) => (b.id || 0) - (a.id || 0));
    try { localStorage.setItem("betscore_historial", JSON.stringify(sorted)); } catch {}
    setRecords(sorted);
  };

  const updateResult = async (id, resultado) => {
    const updated = records.map(r => {
      if (r.id !== id) return r;
      const cuota = r.cuota_jugada||r.cuota_1||1;
      const monto = parseFloat(r.monto_apostado)||0;
      const ganancia = resultado==="GANADA" ? parseFloat((monto*(cuota-1)).toFixed(2)) : resultado==="PERDIDA" ? -monto : 0;
      return { ...r, resultado, ganancia_unidades: ganancia };
    });
    await save(updated);
  };

  const deleteRecord = async (id) => {
    if (!window.confirm("¿Eliminar este registro?")) return;
    await save(records.filter(r => r.id !== id));
  };

  // ── EXPORTAR EXCEL (XML SpreadsheetML) ────────────────────────────
  const exportarExcel = async () => {
    setExporting(true);
    try {
      const won=records.filter(r=>r.resultado==="GANADA");
      const lost=records.filter(r=>r.resultado==="PERDIDA");
      const anuladas=records.filter(r=>r.resultado==="ANULADA");
      const closed=[...won,...lost];
      const totalApostado=records.reduce((s,r)=>s+(parseFloat(r.monto_apostado)||0),0);
      const gNet=records.reduce((s,r)=>{
        const m=parseFloat(r.monto_apostado)||0,c=r.cuota_jugada||r.cuota_1||1;
        if(r.resultado==="GANADA") return s+m*(c-1);
        if(r.resultado==="PERDIDA") return s-m;
        return s;
      },0);
      const wRnum=closed.length>0?(won.length/closed.length)*100:null;
      const wR=wRnum!==null?wRnum.toFixed(1):null;
      const yld=totalApostado>0?((gNet/totalApostado)*100).toFixed(1):null;
      const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/[\u{1F000}-\u{1FFFF}]/gu,'').replace(/[\u2600-\u27BF]/gu,'').trim();
      const sid=res=>({GANADA:'wC',PERDIDA:'lC',ANULADA:'aC',PENDIENTE:'pC'}[res]||'pC');
      const sidL=res=>({GANADA:'wL',PERDIDA:'lL',ANULADA:'aL',PENDIENTE:'pL'}[res]||'pL');
      const sidB=res=>({GANADA:'wB',PERDIDA:'lB',ANULADA:'aC',PENDIENTE:'pC'}[res]||'pC');
      const sumRows=[
        ['TOTAL APUESTAS',String(records.length),'sumV'],
        ['GANADAS',String(won.length),'sumG'],
        ['PERDIDAS',String(lost.length),'sumR'],
        ['ANULADAS',String(anuladas.length),'sumV'],
        ['PENDIENTES',String(records.filter(r=>r.resultado==="PENDIENTE").length),'sumA'],
        ['% ACIERTO',wR?`${wR}%`:'-',wRnum>=55?'sumG':wRnum>=40?'sumA':wR?'sumR':'sumV'],
        ['YIELD',yld?`${parseFloat(yld)>=0?'+':''}${yld}%`:'-',parseFloat(yld)>=0?'sumG':'sumR'],
        ['GANANCIA NETA',gNet!==0?`${gNet>=0?'+':''}$${gNet.toFixed(2)}`:'$0.00',gNet>=0?'sumG':'sumR'],
      ];
      const dataRows=records.map(r=>{
        const cuota=r.cuota_jugada||r.cuota_1||0;
        const monto=parseFloat(r.monto_apostado)||0;
        const gan=r.resultado==="GANADA"?monto*(cuota-1):r.resultado==="PERDIDA"?-monto:r.resultado==="ANULADA"?0:null;
        const ganStr=gan!==null?`${gan>=0?'+':''}$${gan.toFixed(2)}`:'-';
        const catLabel=(CAT[r.categoria]||CAT.premium).label;
        return `<Row ss:Height="22">
          <Cell ss:StyleID="${sid(r.resultado)}"><Data ss:Type="String">${esc(r.fecha_partido||r.fecha_analisis||'-')}</Data></Cell>
          <Cell ss:StyleID="${sidL(r.resultado)}"><Data ss:Type="String">${esc(r.partido||`${r.local||''} vs ${r.visitante||''}`)}</Data></Cell>
          <Cell ss:StyleID="${sid(r.resultado)}"><Data ss:Type="String">${esc(catLabel)}</Data></Cell>
          <Cell ss:StyleID="${sidL(r.resultado)}"><Data ss:Type="String">${esc(r.apuesta_jugada||r.mercado_1||'-')}</Data></Cell>
          <Cell ss:StyleID="${sid(r.resultado)}"><Data ss:Type="String">${cuota?cuota.toFixed(2):'-'}</Data></Cell>
          <Cell ss:StyleID="${sid(r.resultado)}"><Data ss:Type="String">${monto?`$${monto.toFixed(2)}`:'-'}</Data></Cell>
          <Cell ss:StyleID="${sidB(r.resultado)}"><Data ss:Type="String">${esc(r.resultado||'PENDIENTE')}</Data></Cell>
          <Cell ss:StyleID="${sidB(r.resultado)}"><Data ss:Type="String">${esc(ganStr)}</Data></Cell>
        </Row>`;
      }).join('\n');
      const styles=`
  <Style ss:ID="Default"><Font ss:FontName="Calibri" ss:Size="11"/></Style>
  <Style ss:ID="title"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="22" ss:Color="#22C55E"/><Interior ss:Color="#0D1B2A" ss:Pattern="Solid"/></Style>
  <Style ss:ID="titleBall"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="32" ss:Color="#22C55E"/><Interior ss:Color="#0D1B2A" ss:Pattern="Solid"/></Style>
  <Style ss:ID="titleBet"><Alignment ss:Horizontal="Right" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="26" ss:Color="#E2F0FB"/><Interior ss:Color="#0D1B2A" ss:Pattern="Solid"/></Style>
  <Style ss:ID="titleTag"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="8" ss:Color="#22C55E"/><Interior ss:Color="#162436" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sub"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="9" ss:Color="#7EB8D4"/><Interior ss:Color="#0D1B2A" ss:Pattern="Solid"/></Style>
  <Style ss:ID="tagline"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="9" ss:Color="#22C55E"/><Interior ss:Color="#162436" ss:Pattern="Solid"/></Style>
  <Style ss:ID="gap"><Interior ss:Color="#0D1B2A" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sumLbl"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="9" ss:Color="#7EB8D4"/><Interior ss:Color="#162436" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#2A4060"/></Borders></Style>
  <Style ss:ID="sumV"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="14" ss:Color="#E2F0FB"/><Interior ss:Color="#162436" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sumG"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="14" ss:Color="#4ADE80"/><Interior ss:Color="#162436" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sumR"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="14" ss:Color="#F87171"/><Interior ss:Color="#162436" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sumA"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="14" ss:Color="#22C55E"/><Interior ss:Color="#162436" ss:Pattern="Solid"/></Style>
  <Style ss:ID="colH"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="11" ss:Color="#0D1B2A"/><Interior ss:Color="#22C55E" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#16A34A"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#16A34A"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#16A34A"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#16A34A"/></Borders></Style>
  <Style ss:ID="wC"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#065F46"/><Interior ss:Color="#DCFCE7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#4ADE80"/></Borders></Style>
  <Style ss:ID="wL"><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#065F46"/><Interior ss:Color="#DCFCE7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#4ADE80"/></Borders></Style>
  <Style ss:ID="wB"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="10" ss:Color="#14532D"/><Interior ss:Color="#DCFCE7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#4ADE80"/></Borders></Style>
  <Style ss:ID="lC"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#7F1D1D"/><Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FCA5A5"/></Borders></Style>
  <Style ss:ID="lL"><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#7F1D1D"/><Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FCA5A5"/></Borders></Style>
  <Style ss:ID="lB"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Bold="1" ss:Size="10" ss:Color="#7F1D1D"/><Interior ss:Color="#FEE2E2" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FCA5A5"/></Borders></Style>
  <Style ss:ID="aC"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Italic="1" ss:Size="10" ss:Color="#6B7280"/><Interior ss:Color="#E5E7EB" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1D5DB"/></Borders></Style>
  <Style ss:ID="aL"><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Italic="1" ss:Size="10" ss:Color="#6B7280"/><Interior ss:Color="#E5E7EB" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D1D5DB"/></Borders></Style>
  <Style ss:ID="pC"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#92400E"/><Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FDE68A"/></Borders></Style>
  <Style ss:ID="pL"><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#92400E"/><Interior ss:Color="#FEF3C7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#FDE68A"/></Borders></Style>
  <Style ss:ID="foot"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Italic="1" ss:Size="9" ss:Color="#4A7090"/><Interior ss:Color="#0D1B2A" ss:Pattern="Solid"/></Style>`;
      const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">\n<Styles>${styles}</Styles>\n<Worksheet ss:Name="BetFut">\n<Table>\n  <Column ss:Width="100"/><Column ss:Width="190"/><Column ss:Width="90"/><Column ss:Width="160"/><Column ss:Width="55"/><Column ss:Width="75"/><Column ss:Width="80"/><Column ss:Width="90"/>\n  <Row ss:Height="20"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>
  <Row ss:Height="52">
    <Cell ss:StyleID="titleBall" ss:MergeAcross="1"><Data ss:Type="String">&#x26BD;</Data></Cell>
    <Cell ss:StyleID="title"     ss:MergeAcross="5"><Data ss:Type="String">BetFut  |  HISTORIAL DE APUESTAS</Data></Cell>
  </Row>\n  <Row ss:Height="18"><Cell ss:StyleID="sub" ss:MergeAcross="7"><Data ss:Type="String">Exportado el ${esc(new Date().toLocaleString("es-CO"))} - betfut.app - Analisis de apuestas con IA</Data></Cell></Row>\n  <Row ss:Height="8"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>\n  <Row ss:Height="20">${sumRows.map(([l])=>`<Cell ss:StyleID="sumLbl"><Data ss:Type="String">${esc(l)}</Data></Cell>`).join('')}</Row>\n  <Row ss:Height="30">${sumRows.map(([,v,s])=>`<Cell ss:StyleID="${s}"><Data ss:Type="String">${esc(v)}</Data></Cell>`).join('')}</Row>\n  <Row ss:Height="8"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>\n  <Row ss:Height="24">${['FECHA','PARTIDO','CATEGORIA','MERCADO JUGADO','CUOTA','MONTO ($)','RESULTADO','GANANCIA ($)'].map(h=>`<Cell ss:StyleID="colH"><Data ss:Type="String">${h}</Data></Cell>`).join('')}</Row>\n  ${dataRows}\n  <Row ss:Height="8"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>\n  <Row ss:Height="18"><Cell ss:StyleID="foot" ss:MergeAcross="7"><Data ss:Type="String">Las apuestas son sugerencias basadas en analisis estadistico con IA. Juega con responsabilidad. BetFut - betfut.app</Data></Cell></Row>\n</Table>\n</Worksheet>\n</Workbook>`;
      const blob=new Blob([xml],{type:'text/xml;charset=UTF-8'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url; a.download=`BetFut_${new Date().toLocaleDateString('es-CO').replace(/\//g,'-')}.xml`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch(e) { alert('Error: '+e.message); }
    setExporting(false);
  };

  // ── STATS ─────────────────────────────────────────────────────────
  const won      = records.filter(r => r.resultado === "GANADA");
  const lost     = records.filter(r => r.resultado === "PERDIDA");
  const anuladas = records.filter(r => r.resultado === "ANULADA");
  const closed   = [...won, ...lost];
  const totalApostado = records.reduce((s,r)=>s+(parseFloat(r.monto_apostado)||0),0);
  const gNet = records.reduce((s,r)=>{
    const m=parseFloat(r.monto_apostado)||0,c=r.cuota_jugada||r.cuota_1||1;
    if(r.resultado==="GANADA") return s+m*(c-1);
    if(r.resultado==="PERDIDA") return s-m;
    return s;
  },0);
  const winRate = closed.length>0?((won.length/closed.length)*100).toFixed(1):null;
  const totalIngresos = won.reduce((s,r)=>{const m=parseFloat(r.monto_apostado)||0,c=r.cuota_jugada||r.cuota_1||1;return s+m*(c-1);},0);
  const totalGastos   = lost.reduce((s,r)=>s+(parseFloat(r.monto_apostado)||0),0);

  // Agrupar por fecha
  const filtrados = filtro==="TODOS" ? records : records.filter(r=>r.resultado===filtro);
  const porFecha = {};
  filtrados.forEach(r=>{
    const key = r.fecha_partido || r.fecha_analisis || "Sin fecha";
    if(!porFecha[key]) porFecha[key] = [];
    porFecha[key].push(r);
  });
  const fechasOrdenadas = Object.keys(porFecha).sort((a,b)=>b.localeCompare(a));

  const inputS = { background:C.card2, border:`1px solid ${C.border}`, borderRadius:7, padding:"8px 12px", color:C.text, fontSize:13, outline:"none", fontFamily:"inherit", width:"100%", boxSizing:"border-box" };

  if (!loaded) return <div style={{textAlign:"center",color:C.muted,padding:40}}>Cargando...</div>;

  return (
    <div>
      {/* HEADER FINTECH — Balance + Ingresos + Gastos */}
      <div style={{ borderRadius:16, overflow:"hidden", marginBottom:16, border:`1px solid ${C.border}` }}>
        {/* Balance total */}
        <div style={{ background:"linear-gradient(135deg,#0d2218,#0f3020,#162436)", padding:"20px 20px 16px" }}>
          <div style={{ fontSize:11, color:C.muted, letterSpacing:".08em", marginBottom:4 }}>BALANCE TOTAL</div>
          <div style={{ fontSize:36, fontWeight:900, color:gNet>=0?"#10B981":"#EF4444", letterSpacing:"-.02em" }}>
            {gNet>=0?"+":""}{totalApostado>0?`$${gNet.toFixed(2)}`:"$0.00"}
          </div>
          <div style={{ fontSize:12, color:C.dim, marginTop:4 }}>{records.length} apuestas · {closed.length} cerradas{winRate?` · ${winRate}% acierto`:""}</div>
        </div>
        {/* Ingresos / Gastos */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:1, background:C.border }}>
          <div style={{ background:"#052e16", padding:"12px 16px" }}>
            <div style={{ fontSize:10, color:"#6EE7B7", letterSpacing:".06em", marginBottom:2 }}>INGRESOS</div>
            <div style={{ fontSize:20, fontWeight:800, color:"#10B981" }}>+${totalIngresos.toFixed(2)}</div>
            <div style={{ fontSize:10, color:"#34D399", marginTop:1 }}>{won.length} ganadas</div>
          </div>
          <div style={{ background:"#450a0a", padding:"12px 16px" }}>
            <div style={{ fontSize:10, color:"#FCA5A5", letterSpacing:".06em", marginBottom:2 }}>GASTOS</div>
            <div style={{ fontSize:20, fontWeight:800, color:"#EF4444" }}>-${totalGastos.toFixed(2)}</div>
            <div style={{ fontSize:10, color:"#F87171", marginTop:1 }}>{lost.length} perdidas</div>
          </div>
        </div>
        {/* Stats bar */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:1, background:C.border }}>
          {[
            ["TRANSACCIONES", records.length, C.blue],
            ["ANULADAS",       anuladas.length, C.muted],
            ["PENDIENTES",     records.filter(r=>r.resultado==="PENDIENTE").length, C.accent],
          ].map(([l,v,c])=>(
            <div key={l} style={{ background:C.card, padding:"10px", textAlign:"center" }}>
              <div style={{ fontSize:16, fontWeight:800, color:c }}>{v}</div>
              <div style={{ fontSize:9, color:C.dim, marginTop:2, letterSpacing:".05em" }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ACCIONES */}
      <div style={{ display:"flex", gap:8, marginBottom:14 }}>
        <button onClick={exportarExcel} disabled={exporting||records.length===0} style={{ flex:1, background:records.length===0?C.dim:"linear-gradient(135deg,#16a34a,#22c55e)", color:"#fff", border:"none", borderRadius:8, padding:"11px", fontWeight:800, fontSize:13, cursor:records.length===0?"not-allowed":"pointer" }}>
          {exporting?"Exportando...":"📥 Exportar Excel"}
        </button>
        <button onClick={()=>setShowAdd(!showAdd)} style={{ flex:1, background:C.accent, color:"#000", border:"none", borderRadius:8, padding:"11px", fontWeight:800, fontSize:13, cursor:"pointer" }}>
          {showAdd?"✕ Cancelar":"+ Manual"}
        </button>
      </div>

      {/* FORM MANUAL */}
      {showAdd && (
        <div style={{ background:C.card, border:`1px solid ${C.accent}44`, borderRadius:12, padding:"16px", marginBottom:14 }}>
          <div style={{ fontWeight:700, fontSize:13, color:C.accent, marginBottom:12 }}>Registro manual</div>
          {/* Categoría */}
          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            {CATEGORIAS.map(c=>(
              <button key={c.id} onClick={()=>setForm(f=>({...f,categoria:c.id}))} style={{ flex:1, padding:"7px 4px", borderRadius:8, border:`1.5px solid ${form.categoria===c.id?c.color:C.border}`, background:form.categoria===c.id?c.bg:"transparent", cursor:"pointer", fontSize:11, fontWeight:700, color:form.categoria===c.id?c.color:C.muted }}>
                {c.icon} {c.label}
              </button>
            ))}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
            <div><div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Partido *</div><input style={inputS} value={form.partido} onChange={e=>setForm(f=>({...f,partido:e.target.value}))} placeholder="Local vs Visitante"/></div>
            <div><div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Mercado</div><input style={inputS} value={form.mercado} onChange={e=>setForm(f=>({...f,mercado:e.target.value}))} placeholder="Over 2.5 Goles"/></div>
            <div><div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Cuota *</div><input style={inputS} type="number" step="0.01" value={form.cuota} onChange={e=>setForm(f=>({...f,cuota:e.target.value}))} placeholder="1.75"/></div>
            <div><div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Fecha</div><input style={inputS} value={form.fecha} onChange={e=>setForm(f=>({...f,fecha:e.target.value}))} placeholder="DD/MM/YYYY"/></div>
          </div>
          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            {["PENDIENTE","GANADA","PERDIDA","ANULADA"].map(res=>(
              <button key={res} onClick={()=>setForm(f=>({...f,resultado:res}))} style={{ flex:1, padding:"6px 4px", borderRadius:6, border:`1px solid ${form.resultado===res?(res==="GANADA"?"#10B981":res==="PERDIDA"?"#EF4444":res==="ANULADA"?"#6B7280":C.accent):C.border}`, background:form.resultado===res?(res==="GANADA"?"#052e16":res==="PERDIDA"?"#450a0a":res==="ANULADA"?"#1f2937":C.accent+"22"):"transparent", color:res==="GANADA"?"#10B981":res==="PERDIDA"?"#EF4444":res==="ANULADA"?"#6B7280":C.accent, fontSize:10, fontWeight:700, cursor:"pointer" }}>
                {res==="GANADA"?"✅":res==="PERDIDA"?"❌":res==="ANULADA"?"🚫":"⏳"} {res}
              </button>
            ))}
          </div>
          <button onClick={async()=>{
            if(!form.partido||!form.cuota) return;
            const cuota=parseFloat(form.cuota), monto=0;
            const ganancia=form.resultado==="GANADA"?monto*(cuota-1):form.resultado==="PERDIDA"?-monto:0;
            const newRec={id:Date.now(),partido:form.partido,mercado_1:form.mercado,apuesta_jugada:form.mercado,cuota_1:cuota,cuota_jugada:cuota,resultado:form.resultado,ganancia_unidades:ganancia,fecha_analisis:form.fecha||new Date().toLocaleDateString("es-CO"),fecha_partido:form.fecha||"",categoria:form.categoria||"premium"};
            await save([newRec,...records]);
            setForm({partido:"",mercado:"",cuota:"",resultado:"PENDIENTE",fecha:"",categoria:"premium"});
            setShowAdd(false);
          }} disabled={!form.partido||!form.cuota} style={{ width:"100%", background:"linear-gradient(135deg,#16a34a,#22c55e)", color:"#fff", border:"none", borderRadius:7, boxShadow:"0 4px 15px rgba(34,197,94,0.35)", padding:"10px", fontWeight:800, fontSize:13, cursor:"pointer" }}>
            Guardar
          </button>
        </div>
      )}

      {/* FILTROS */}
      <div style={{ display:"flex", gap:4, marginBottom:4, background:C.card, borderRadius:10, padding:4, border:`1px solid ${C.border}` }}>
        {[["TODOS",`Todos (${records.length})`],["PENDIENTE","⏳"],["GANADA","✅"],["PERDIDA","❌"],["ANULADA","🚫"]].map(([k,l])=>(
          <button key={k} onClick={()=>setFiltro(k)} style={{ flex:1, background:filtro===k?(k==="GANADA"?"linear-gradient(135deg,#16a34a,#22c55e)":k==="PERDIDA"?"#ef4444":k==="ANULADA"?"#6B7280":k==="PENDIENTE"?"linear-gradient(135deg,#d97706,#f59e0b)":"linear-gradient(135deg,#1d4ed8,#3b82f6)"):"transparent", color:filtro===k?"#fff":C.muted, border:"none", borderRadius:7, padding:"8px 4px", fontWeight:700, fontSize:11, cursor:"pointer" }}>{l}</button>
        ))}
      </div>

      {/* LISTA AGRUPADA POR FECHA */}
      {records.length===0
        ? <div style={{ textAlign:"center", color:C.dim, padding:"40px 20px", background:C.card, borderRadius:12, border:`1px solid ${C.border}`, marginTop:8 }}>
            <div style={{ fontSize:32, marginBottom:10 }}>📋</div>
            <div style={{ fontSize:14, color:C.muted }}>Los análisis se guardan aquí automáticamente</div>
          </div>
        : <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden", marginTop:8 }}>
            {fechasOrdenadas.length===0
              ? <div style={{ padding:20, textAlign:"center", color:C.dim, fontSize:13 }}>Sin registros con este filtro</div>
              : fechasOrdenadas.map(fecha=>{
                  const grupo = porFecha[fecha];
                  const ingresos = grupo.filter(r=>r.resultado==="GANADA").reduce((s,r)=>{const m=parseFloat(r.monto_apostado)||0,c=r.cuota_jugada||r.cuota_1||1;return s+m*(c-1);},0);
                  const gastos   = grupo.filter(r=>r.resultado==="PERDIDA").reduce((s,r)=>s+(parseFloat(r.monto_apostado)||0),0);
                  return (
                    <div key={fecha}>
                      {/* Cabecera de fecha */}
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", background:C.card2, borderBottom:`1px solid ${C.border}`, borderTop:`1px solid ${C.border}` }}>
                        <span style={{ fontSize:12, fontWeight:700, color:C.muted }}>{fecha}</span>
                        <div style={{ display:"flex", gap:12 }}>
                          {gastos>0  && <span style={{ fontSize:12, fontWeight:700, color:"#EF4444" }}>-${gastos.toFixed(2)}</span>}
                          {ingresos>0 && <span style={{ fontSize:12, fontWeight:700, color:"#10B981" }}>+${ingresos.toFixed(2)}</span>}
                        </div>
                      </div>
                      {/* Transacciones del día */}
                      {grupo.map(r=>(
                        <TransaccionCard
                          key={r.id} r={r}
                          onResult={updateResult}
                          onDelete={deleteRecord}
                          records={records}
                          save={save}
                        />
                      ))}
                    </div>
                  );
                })
            }
          </div>
      }
    </div>
  );
}
// ─── APP PRINCIPAL ────────────────────────────────────────────────────────────
// Token FRESCO de Supabase en cada peticion a los endpoints protegidos:
// getSession() renueva el access_token si caduco — adjuntar uno guardado al
// montar acabaria enviando tokens vencidos a mitad de sesion.
const cabecerasAuth = async () => {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const t = data?.session?.access_token;
  return t ? { Authorization: `Bearer ${t}` } : {};
};

export default function BetFutProV3() {
  // Fijar color de fondo en body para evitar fondo blanco en overscroll móvil
  if (typeof document !== "undefined") {
    document.body.style.background = "#0d1b2a";
    document.body.style.margin = "0";
    document.documentElement.style.background = "#0d1b2a";
  }

  // ── Auth state ──────────────────────────────────────────
  const [user, setUser]       = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    if (!supabase) { setAuthLoading(false); return; }
    // Sesión actual
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user || null);
      if (session?.user) loadProfile(session.user.id);
      setAuthLoading(false);
    });
    // Listener de cambios de auth
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
      if (session?.user) loadProfile(session.user.id);
      else setProfile(null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadProfile = async (userId) => {
    if (!supabase) return;
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    setProfile(data);
  };
  const [bank, setBank] = useState(1000);
  const [savedAnalysis, setSavedAnalysis] = useState(null);
  const [guardadoId, setGuardadoId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  // Aviso no bloqueante: el analisis sigue con el respaldo web, pero el
  // usuario ve por que faltan los datos reales.
  const [aviso, setAviso] = useState(null);
  const [tab, setTab] = useState("mercados");
  const [postMode, setPostMode] = useState("telegram");
  const [copied, setCopied] = useState(false);
  const [mainTab, setMainTab] = useState("analizar");
  // Que partido del calendario se esta analizando, para que solo SU boton
  // muestre "Analizando..." y no todos.
  const [analizandoId, setAnalizandoId] = useState(null);
  // Candado sincrono contra la doble pulsacion: entre el arranque y el
  // setLoading hay un await (el chequeo de limite), y en esa ventana un
  // segundo toque lanzaba OTRO analisis: doble consumo de cuota del plan y
  // doble llamada a la IA. El estado `loading` no sirve de guardia porque
  // aun no esta puesto; un ref si, porque cambia en el acto.
  const analisisEnCurso = useRef(false);
  // 3C: el dia elegido vive aqui y no dentro de Calendario, porque cambiar a
  // la vista de analisis desmonta el componente y un estado interno volveria
  // siempre a "hoy". El padre no se desmonta nunca.
  const [diaSel, setDiaSel] = useState(2);
  // De que tarjeta nacio el analisis en curso (toda entrada viene de una) y
  // objetivo pendiente de scroll al volver.
  const ultimoFixture = useRef(null);
  // Id del ELEMENTO al que volver en el calendario: "partido-123" (Volver) o
  // "liga-brasil-serie-a" (panel lateral). Un solo mecanismo para ambos.
  const [objetivoScroll, setObjetivoScroll] = useState(null);
  // Ligas con partidos en el dia del analisis en curso, para el panel y el
  // menu ☰. La rellena la tarjeta que lanza el analisis; el guardado de
  // length > 0 al pintar queda como defensa.
  const [ligasDelDia, setLigasDelDia] = useState([]);
  // Nombres de liga por dia (indice = pestana de dia), subidos por Calendario
  // al cargar. Viven aqui para que el menu ☰ los tenga aunque el calendario
  // este desmontado (historial, analisis).
  const [ligasPorDia, setLigasPorDia] = useState([]);
  const [menuLigas, setMenuLigas] = useState(false);
  // Menu de usuario del avatar. mousedown/touchstart y no click para el
  // cierre por fuera: con click, el mismo clic que abre tambien cierra.
  const [menuUsuario, setMenuUsuario] = useState(false);
  const menuUsuarioRef = useRef(null);

  useEffect(() => {
    if (!menuUsuario) return;
    const fuera = (e) => {
      if (!menuUsuarioRef.current?.contains(e.target)) setMenuUsuario(false);
    };
    const tecla = (e) => { if (e.key === "Escape") setMenuUsuario(false); };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("touchstart", fuera);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("touchstart", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [menuUsuario]);

  const guardarEnHistorial = (mercado) => {
    if (!savedAnalysis) return;
    const KEY = "betscore_historial";
    let prev = [];
    try { prev = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch {}
    const id = Date.now();
    const newRecord = {
      id,
      fecha_analisis: new Date().toLocaleDateString("es-CO"),
      hora_analisis: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }),
      partido: savedAnalysis.local + " vs " + savedAnalysis.visitante,
      local: savedAnalysis.local,
      visitante: savedAnalysis.visitante,
      competicion: savedAnalysis.competicion,
      fecha_partido: savedAnalysis.fecha_partido,
      mercado_1: String(mercado.nombre || "—"),
      desc_1: String(mercado.descripcion || "—"),
      cuota_1: Number(mercado.cuota) || 0,
      ev_1: Number(parseFloat(((mercado.ev || 0) * 100).toFixed(1))) || 0,
      confianza_1: String(mercado.nivel_confianza || "—"),
      fuente_1: String(mercado.cuota_fuente || "Estimada"),
      prob_local: savedAnalysis.prob_local,
      prob_empate: savedAnalysis.prob_empate,
      prob_visitante: savedAnalysis.prob_visitante,
      bajas_local: savedAnalysis.bajas_local,
      bajas_visitante: savedAnalysis.bajas_visitante,
      resultado: "PENDIENTE",
      apuesta_jugada: String(mercado.nombre || "—"),
      cuota_jugada: Number(mercado.cuota) || 0,
      monto_apostado: 0,
      ganancia_unidades: null,
      categoria: "premium",
    };
    const allRecs = [newRecord, ...prev].sort((a, b) => (b.id || 0) - (a.id || 0));
    const serialized = JSON.stringify(allRecs);
    localStorage.setItem(KEY, serialized);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: serialized }));
    // ── Sync a Supabase ───────────────────────────────────
    if (user) saveHistorialSupabase(user.id, newRecord);
    setGuardadoId(id);
  };

  const analyze = async (opciones) => {
    // Unica entrada: las tarjetas del calendario, que pasan el partido ya
    // identificado y su fixtureId (evita la resolucion de nombres en el
    // backend). El buscador manual del pie se retiro con la Ola 1 completa.
    const { local, visitante, fixtureId, timestamp } = opciones;

    if (!local || !visitante) return;

    // Sin sesion no hay analisis: el servidor responde 401 de todos modos.
    // Se corta aqui — sin navegar, sin cache — y se manda al login.
    if (!user) {
      setAviso({ nivel: "error", texto: "Inicia sesión para ver el análisis." });
      loginGoogle();
      return;
    }

    if (analisisEnCurso.current) return;
    analisisEnCurso.current = true;

    setAnalizandoId(fixtureId);
    ultimoFixture.current = fixtureId;

    // Partido ya empezado (ventana rara: el calendario servido hace <3 min
    // aun pintaba el boton). Su pronostico cacheado ya no es vigente: ni se
    // sirve ni se guarda; se genera en vivo como siempre.
    const empezado = Boolean(timestamp) && timestamp * 1000 <= Date.now();

    // ── Verificar límite de plan (opcion B: cuota por fixture NUEVO) ──
    // Abrir un analisis descuenta solo la primera vez que este usuario ve
    // este fixture; reabrirlo es gratis.
    if (supabase && user) {
      const repetido = await yaVioFixture(user.id, fixtureId);
      if (!repetido) {
        const check = await checkAndIncrementAnalysis(user.id);
        if (!check.allowed) {
          // sin_perfil: la cuenta no tiene fila en profiles (el trigger de
          // registro no llego a crearla). Re-entrar la regenera; el mensaje
          // de limite normal aqui seria mentira.
          setError(check.sin_perfil
            ? "Tu perfil no se creó correctamente. Cierra sesión y vuelve a entrar para regenerarlo."
            : `Alcanzaste tu límite de ${check.limite} análisis/día (plan ${check.plan?.toUpperCase()}). Actualiza tu plan para más.`);
          setAnalizandoId(null);
          analisisEnCurso.current = false;
          // No se cambia de vista: el aviso se pinta sobre el calendario, y se
          // sube al tope para que no quede fuera de pantalla.
          window.scrollTo({ top: 0 });
          return;
        }
        // Se marca al cobrar, no al terminar: si la generacion falla, el
        // reintento del mismo fixture ya no descuenta otra vez.
        await marcarFixtureVisto(user.id, fixtureId);
      }
    }

    // El analisis tiene vista propia y se entra en ella al arrancar, no al
    // terminar: asi el progreso se ve desde el primer segundo y un fallo
    // aparece donde el usuario esta mirando.
    setMainTab("analisis");
    window.scrollTo({ top: 0 });

    // ── Verificar caché (por fixture_id) ──────────────────
    // La pestana interna arranca siempre en Mercados. Aqui y no al final de
    // la generacion: este es el unico punto por el que pasan TODOS los
    // caminos (cache hit incluido, que antes arrastraba la pestana del
    // analisis anterior).
    setLoading(true); setError(""); setAviso(null); setData(null); setTab("mercados");
    setProgress("⚡ Verificando caché de análisis...");
    const cached = empezado ? null : await getCachedAnalysis(fixtureId);
    if (cached) {
      setData(cached);
      setSavedAnalysis({
        local: cached?.partido?.local || local,
        visitante: cached?.partido?.visitante || visitante,
        competicion: cached?.partido?.competicion || "N/D",
        fecha_partido: cached?.partido?.fecha || "Próximos días",
        prob_local: cached?.probabilidades_1x2?.victoria_local || 0,
        prob_empate: cached?.probabilidades_1x2?.empate || 0,
        prob_visitante: cached?.probabilidades_1x2?.victoria_visitante || 0,
        bajas_local: "Ver análisis", bajas_visitante: "Ver análisis",
      });
      setLoading(false);
      setAnalizandoId(null);
      analisisEnCurso.current = false;
      return;
    }

    const steps = [
      "🔍 Buscando cuotas reales en Bet365/Betfair...",
      "🏥 Verificando lesionados y bajas específicas...",
      "📊 Analizando 8+ mercados de apuesta...",
      "⚖️ Calculando valor esperado (EV) por mercado...",
      "🏆 Generando análisis final... (puede tardar hasta 60s)",
    ];
    let si = 0;
    setProgress(steps[0]);
    // Avanza cada 6s; cuando llega al último paso se queda ahí con un contador
    let extraSecs = 0;
    const iv = setInterval(() => {
      if (si < steps.length - 1) { si++; setProgress(steps[si]); }
      else { extraSecs += 6; setProgress(`🏆 Generando análisis final... (${extraSecs}s)`); }
    }, 6000);

    const apiCall = async (system, messages, withSearch = false, maxTok = 4000, timeoutMs = 90000) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const directCall = async () => {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: maxTok,
            system,
            messages,
            ...(withSearch ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {})
          }),
          signal: controller.signal,
        });
        return res.json();
      };

      try {
        let json;
        try {
          const proxyRes = await fetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(await cabecerasAuth()) },
            body: JSON.stringify({ system, messages, withSearch, maxTokens: maxTok }),
            signal: controller.signal,
          });
          const text = await proxyRes.text();
          if (text.trimStart().startsWith("<")) {
            json = await directCall();
          } else {
            json = JSON.parse(text);
          }
        } catch (proxyErr) {
          if (proxyErr.name === "AbortError") throw new Error("Tiempo de espera agotado (90s). Intenta de nuevo.");
          json = await directCall();
        }
        clearTimeout(timer);
        if (json.error) throw new Error(json.error.message || json.error || "API error");
        return (json.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      } catch (e) {
        clearTimeout(timer);
        if (e.name === "AbortError") throw new Error("Tiempo de espera agotado (90s). Intenta de nuevo.");
        throw e;
      }
    };

    try {
      // PASO 1 — API-Football (datos reales: fixture, lesionados, cuotas, stats)
      setProgress("🔍 Consultando datos reales en API-Football...");

      let footballData = null;
      let searchData = "";

      try {
        // Intentar API-Football primero (Vercel) o web search (Claude artifact)
        const footballRes = await fetch("/api/football", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await cabecerasAuth()) },
          // Con fixtureId el backend sabe exactamente que partido es; sin el,
          // lo resuelve por nombres como hasta ahora.
          body: JSON.stringify(
            fixtureId ? { fixture_id: fixtureId } : { local, visitante }
          ),
        });

        const footballText = await footballRes.text();

        // Se parsea aunque la respuesta no sea ok: el motivo del fallo viaja
        // en el cuerpo y perderlo era justo lo que dejaba al usuario con un
        // mensaje generico.
        if (!footballText.trimStart().startsWith("<")) {
          footballData = JSON.parse(footballText);
        }
      } catch { /* fallback a web search */ }

      // El backend ya distingue "la API fallo" de "no hay datos". Ese motivo
      // se enseña en pantalla en vez de quedarse solo en el JSON.
      if (footballData?.error_api) {
        setAviso({ nivel: "error", texto: `Sin datos de API-Football — ${footballData.mensaje}` });
      } else if (footballData && !footballData.encontrado && footballData.mensaje) {
        setAviso({ nivel: "info", texto: footballData.mensaje });
      } else if (footballData?.avisos?.length) {
        setAviso({ nivel: "error", texto: `Datos incompletos de API-Football — ${footballData.avisos.join(" · ")}` });
      }

      if (footballData?.encontrado) {
        // El resumen con datos reales se arma en api/_analysis.js
        searchData = construirSearchData(footballData);
        setProgress("✅ Datos reales obtenidos — Generando análisis con IA...");
      } else {
        // Sin datos de API-Football: Claude analiza con conocimiento propio
        setProgress("🧠 Analizando con conocimiento de IA...");
        searchData = searchDataSinDatos(local, visitante);
      }

      // PASO 2 — JSON con delimitadores explícitos — max_tokens suficiente sin exceder
      setProgress("⚖️ Calculando EV en 8+ mercados...");
      const jsonRaw = await apiCall(
        SYSTEM_PROMPT,
        [{ role: "user", content: construirMensajeUsuario(local, visitante, searchData) }],
        false,
        4000,
        120000
      );

      clearInterval(iv);

      // Parseo, normalizacion y posts viven en api/_analysis.js: el JSON que
      // se guarda en cache debe ser identico lo genere quien lo genere, porque
      // el cache-hit lo pinta tal cual sin volver a normalizar.
      const parsed = parsearRespuestaAnalisis(jsonRaw);
      normalizarAnalisis(parsed);
      const { bL, bV, pr } = adjuntarPosts(parsed);

      setData(parsed);

      // ── Guardar en caché Supabase (por fixture, caduca al kickoff) ──
      if (!empezado) saveAnalysisCache(fixtureId, timestamp, local, visitante, parsed);

      // ── Guardar snapshot del análisis para permitir guardar desde cada mercado ──
      setSavedAnalysis({
        partido: parsed?.partido,
        local: parsed?.partido?.local || local || "",
        visitante: parsed?.partido?.visitante || visitante || "",
        competicion: parsed?.partido?.competicion || "N/D",
        fecha_partido: parsed?.partido?.fecha || "Próximos días",
        prob_local: Number(pr?.victoria_local) || 0,
        prob_empate: Number(pr?.empate) || 0,
        prob_visitante: Number(pr?.victoria_visitante) || 0,
        bajas_local: String(bL || "Sin bajas"),
        bajas_visitante: String(bV || "Sin bajas"),
      });
    } catch (e) {
      clearInterval(iv);
      setError("Error: " + e.message + " — Intenta de nuevo.");
    } finally { setLoading(false); setProgress(""); setAnalizandoId(null); analisisEnCurso.current = false; }
  };

  const copy = (text) => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  // Progreso, error y aviso clasificado. Se pinta en la vista activa, encima
  // del contenido, que es donde el usuario esta mirando.
  const bloqueEstado = (
    <>
      {loading && progress && (
        <div style={{ marginBottom: 16, textAlign: "center", fontSize: 13, color: C.muted }}>
          <div style={{ width: "100%", height: 3, background: C.border, borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ height: "100%", background: C.accent, animation: "progress 18s linear forwards", width: "0%" }} />
          </div>
          <style>{`@keyframes progress { to { width: 95%; } }`}</style>
          {progress}
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 16, color: C.red, fontSize: 13, background: C.redDim, borderRadius: 8, padding: "10px 14px" }}>
          {error}
        </div>
      )}
      {aviso && (
        <div style={{
          marginBottom: 16, fontSize: 13, borderRadius: 8, padding: "10px 14px",
          color: aviso.nivel === "error" ? C.amber : C.muted,
          background: aviso.nivel === "error" ? C.amberDim : C.card2,
          border: `1px solid ${aviso.nivel === "error" ? C.amber + "55" : C.border}`,
        }}>
          {aviso.nivel === "error" ? "⚠️ " : "ℹ️ "}{aviso.texto}
        </div>
      )}
    </>
  );

  // Atajo del panel lateral: volver al calendario (mismo dia, que diaSel
  // conserva) situado en la seccion de esa liga. Mismo mecanismo que el
  // Volver del 3C, con el ancla de la liga en vez de la tarjeta.
  const irALiga = (nombre) => {
    setObjetivoScroll(`liga-${slugLiga(nombre)}`);
    setMainTab("analizar");
  };

  // Menu ☰ (solo movil). Las ligas del DIA RELEVANTE: en el calendario el dia
  // visible, en la vista de analisis el dia del analisis (la misma lista que
  // recibe el panel lateral), y en vistas sin dia (historial), HOY.
  const ligasDelMenu = mainTab === "analisis"
    ? ligasDelDia
    : (ligasPorDia[mainTab === "analizar" ? diaSel : 2] || []);

  const elegirLigaMenu = (nombre) => {
    setMenuLigas(false);
    // En una vista sin dia el salto es al calendario de HOY; irALiga reusa el
    // ancla unificada (objetivoScroll) del 3C y el panel lateral.
    if (mainTab === "historial") setDiaSel(2);
    irALiga(nombre);
  };

  const volverAlCalendario = () => {
    // Se vuelve a la tarjeta que lanzo el analisis (el scroll lo hace
    // Calendario cuando los dias estan pintados; si la tarjeta ya no existe,
    // el objetivo se consume sin desplazar). Todo analisis nace de una
    // tarjeta desde que el buscador del pie se retiro.
    setObjetivoScroll(`partido-${ultimoFixture.current}`);
    setMainTab("analizar");
  };

  // Boton de inicio (logo y pestana Analizar): siempre el calendario en HOY
  // y arriba. Conservar el dia y la tarjeta es cosa del "Volver" de la vista
  // de analisis (volverAlCalendario), no de este atajo.
  const irAlInicio = () => {
    setMainTab("analizar");
    setDiaSel(2);
    setObjetivoScroll(null);
    // El scroll se difiere a despues del re-render: lanzado en el propio click
    // muere cuando el cambio de vista altera la altura de la pagina (anclaje
    // del navegador) y la pantalla queda a media altura en vez de arriba.
    // Instantaneo, como el resto de saltos de vista (volverAlCalendario).
    setTimeout(() => window.scrollTo(0, 0), 0);
  };

  const top3 = data?.mercados_analizados?.slice().sort((a, b) => a.ranking - b.ranking).slice(0, 3) || [];
  const otros = data?.mercados_analizados?.filter(m => !m.recomendado) || [];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter','Segoe UI',sans-serif", paddingBottom: 60, overflowX: "hidden" }}>

      {/* HEADER */}
      <div style={{ background: `linear-gradient(135deg, #0d1b2a 0%, #162436 60%, #1c2e44 100%)`, borderBottom: `1px solid ${C.border}`, padding: "18px 24px 14px" }}>
        <style>{`
          .hdr-menu { display: none; }
          @media (max-width: 767px) {
            .hdr-analizar { display: none; }
            .hdr-menu { display: inline-flex; align-items: center; justify-content: center; }
            .hdr-logo { width: 141px; height: 44px; }
          }
        `}</style>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              <svg className="hdr-logo" onClick={irAlInicio} width="420" height="131" viewBox="0 0 1600 500" preserveAspectRatio="xMinYMid meet" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 1, minWidth: 0, cursor: "pointer" }} aria-label="BetFut" role="button">
                <defs>
                  <clipPath id="bfHeaderClip"><circle cx="100" cy="100" r="84"/></clipPath>
                  <linearGradient id="bfHeaderGrad" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#00E676" stopOpacity="1"/>
                    <stop offset="1" stopColor="#22D3EE" stopOpacity="1"/>
                  </linearGradient>
                </defs>
                <g transform="translate(110 100) scale(1.5)">
                  <g clipPath="url(#bfHeaderClip)">
                    <circle cx="100" cy="100" r="84" fill="#F2F7F4"/>
                    <g stroke="#060F1A" strokeWidth="6" strokeLinecap="round">
                      <line x1="100" y1="66" x2="100" y2="16"/>
                      <line x1="132.3" y1="89.5" x2="180.8" y2="73.7"/>
                      <line x1="120" y1="127.5" x2="150" y2="168.8"/>
                      <line x1="80" y1="127.5" x2="50" y2="168.8"/>
                      <line x1="67.7" y1="89.5" x2="19.2" y2="73.7"/>
                    </g>
                    <polygon points="100,66 132.3,89.5 120,127.5 80,127.5 67.7,89.5" fill="#060F1A"/>
                    <g fill="#060F1A">
                      <polygon points="0,-26 24.7,-8 15.3,21 -15.3,21 -24.7,-8" transform="translate(151.7 28.8) rotate(-144)"/>
                      <polygon points="0,-26 24.7,-8 15.3,21 -15.3,21 -24.7,-8" transform="translate(183.7 127.2) rotate(-72)"/>
                      <polygon points="0,-26 24.7,-8 15.3,21 -15.3,21 -24.7,-8" transform="translate(100 188)"/>
                      <polygon points="0,-26 24.7,-8 15.3,21 -15.3,21 -24.7,-8" transform="translate(16.3 127.2) rotate(72)"/>
                      <polygon points="0,-26 24.7,-8 15.3,21 -15.3,21 -24.7,-8" transform="translate(48.3 28.8) rotate(144)"/>
                    </g>
                    <g fill="none" stroke="#22D3EE" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="100,66 100,44 118,44"/>
                      <polyline points="132.3,89.5 156,84 156,66"/>
                      <polyline points="80,127.5 66,148 44,148"/>
                    </g>
                    <g fill="#22D3EE">
                      <circle cx="100" cy="66" r="4.6"/>
                      <circle cx="132.3" cy="89.5" r="4.6"/>
                      <circle cx="120" cy="127.5" r="4.6"/>
                      <circle cx="80" cy="127.5" r="4.6"/>
                      <circle cx="67.7" cy="89.5" r="4.6"/>
                      <circle cx="118" cy="44" r="3.2"/>
                      <circle cx="156" cy="66" r="3.2"/>
                      <circle cx="44" cy="148" r="3.2"/>
                    </g>
                  </g>
                  <circle cx="100" cy="100" r="84" fill="none" stroke="#F2F7F4" strokeWidth="3"/>
                </g>
                <text x="486" y="268" fontFamily="'Bricolage Grotesque', 'Helvetica Neue', Arial, sans-serif" fontWeight="800" fontSize="150" letterSpacing="-6.75" fill="#F2F7F4">Bet<tspan fill="#00E676">Fut</tspan></text>
                <circle cx="492" cy="308" r="6" fill="#00E676"/>
                <rect x="518" y="306" width="420" height="4" rx="2" fill="url(#bfHeaderGrad)"/>
                <rect x="964" y="280" width="112" height="56" rx="10" fill="none" stroke="rgba(34,211,238,0.55)" strokeWidth="2"/>
                <text x="1020" y="320" textAnchor="middle" fontFamily="'Bitcount Prop Single', 'Courier New', monospace" fontSize="30" fill="#22D3EE">IA</text>
                <text x="488" y="386" fontFamily="'Bitcount Prop Single', 'Courier New', monospace" fontSize="26" fill="#7E96A8">ANALISIS Y PRONOSTICOS DE FUTBOL</text>
              </svg>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0, position: "relative" }}>
              {[["analizar", "⚡ Analizar"], ["historial", "📋 Historial"]].map(([k, l]) => (
                <button key={k} className={k === "analizar" ? "hdr-analizar" : undefined} onClick={() => {
                  // Analizar comparte el atajo de inicio con el logo (HOY y
                  // arriba); en movil la pestana se oculta y queda el logo.
                  if (k === "analizar") irAlInicio(); else setMainTab(k);
                }} style={{
                  background: mainTab === k ? "linear-gradient(135deg,#16a34a,#22c55e)" : "transparent",
                  color: mainTab === k ? "#fff" : C.muted,
                  border: `1px solid ${mainTab === k ? "#22c55e" : C.border}`,
                  boxShadow: mainTab === k ? "0 2px 12px rgba(34,197,94,0.3)" : "none",
                  borderRadius: 8, padding: "7px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer"
                }}>{l}</button>
              ))}
              {/* Auth button */}
              {supabase && (
                user ? (
                  <div style={{ position: "relative" }} ref={menuUsuarioRef}>
                    <div
                      role="button"
                      aria-haspopup="menu"
                      aria-expanded={menuUsuario}
                      onClick={() => setMenuUsuario((v) => !v)}
                      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                        background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8,
                        padding: "6px 10px" }}
                    >
                      {user.user_metadata?.avatar_url
                        ? <img src={user.user_metadata.avatar_url} style={{ width: 22, height: 22, borderRadius: "50%" }} alt=""/>
                        : <div style={{ width: 22, height: 22, borderRadius: "50%", background: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700 }}>
                            {(user.email || "U")[0].toUpperCase()}
                          </div>}
                      <div style={{ fontSize: 10, fontWeight: 700, color: PLAN_LIMITS[profile?.plan || "free"]?.color || C.accent }}>
                        {PLAN_LIMITS[profile?.plan || "free"]?.label || "Free"}
                      </div>
                      <span style={{ fontSize: 9, color: C.dim }}>▾</span>
                    </div>

                    {menuUsuario && (
                      <div
                        role="menu"
                        style={{
                          // zIndex por encima de todo lo existente (el maximo
                          // actual es el menu de ligas, 50). Ningun ancestro
                          // del header recorta: el menu de ligas, absoluto en
                          // esta misma fila, ya cuelga sin recortes.
                          position: "absolute", right: 0, top: "calc(100% + 6px)",
                          zIndex: 1000, minWidth: 210, maxWidth: 260,
                          background: C.card, border: `1px solid ${C.border}`,
                          borderRadius: 10, padding: 6,
                          boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                        }}
                      >
                        <div style={{ padding: "8px 12px", minHeight: 44, boxSizing: "border-box" }}>
                          <div style={{ fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {user.email}
                          </div>
                          <div style={{ fontSize: 11, fontWeight: 700, marginTop: 3, color: PLAN_LIMITS[profile?.plan || "free"]?.color || C.accent }}>
                            Plan {PLAN_LIMITS[profile?.plan || "free"]?.label || "Free"}
                          </div>
                        </div>
                        <div style={{ height: 1, background: C.border, margin: "4px 0" }} />
                        {/* FUTURO: "Mi suscripción" va aquí */}
                        <button
                          role="menuitem"
                          onClick={() => { setMenuUsuario(false); logout(); }}
                          style={{
                            display: "flex", alignItems: "center", width: "100%",
                            minHeight: 44, padding: "0 12px", boxSizing: "border-box",
                            background: "transparent", border: "none", cursor: "pointer",
                            color: C.red, fontSize: 13, fontWeight: 600, textAlign: "left",
                            borderRadius: 8,
                          }}
                        >
                          Cerrar sesión
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button onClick={loginGoogle} style={{
                    background: "#fff", color: "#333", border: "none",
                    borderRadius: 8, padding: "7px 12px", fontWeight: 700,
                    fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6
                  }}>
                    <span>G</span> Login
                  </button>
                )
              )}
              {/* ☰ solo movil: ligas del dia relevante */}
              <button className="hdr-menu" aria-label="Menú" aria-expanded={menuLigas} onClick={() => setMenuLigas(v => !v)} style={{
                background: menuLigas ? C.card2 : "transparent", color: C.muted, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: "6px 10px", fontSize: 16, lineHeight: 1, cursor: "pointer"
              }}>☰</button>
              {menuLigas && (
                <>
                  {/* Telon: cierra al tocar fuera (el propio ☰ queda debajo,
                      asi el segundo toque tambien cierra). */}
                  <div onClick={() => setMenuLigas(false)} style={{
                    position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.35)"
                  }} />
                  <div style={{
                    position: "absolute", top: "calc(100% + 10px)", right: 0, zIndex: 50,
                    width: "min(78vw, 300px)", maxHeight: "60vh", overflowY: "auto",
                    background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
                    padding: 8, boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.dim, letterSpacing: ".06em", padding: "8px 10px 6px" }}>
                      LIGAS DEL DIA
                    </div>
                    {ligasDelMenu.length === 0 && (
                      <div style={{ fontSize: 13, color: C.muted, padding: "10px 10px 12px" }}>
                        Sin partidos este día
                      </div>
                    )}
                    {ligasDelMenu.map((nombre) => {
                      // Mismas dos columnas pais | liga del panel lateral,
                      // con mas alto de fila para tocar con el dedo.
                      const sep = nombre.indexOf(" · ");
                      const pais = sep >= 0 ? nombre.slice(0, sep) : null;
                      const liga = sep >= 0 ? nombre.slice(sep + 3) : nombre;
                      return (
                        <button
                          key={nombre}
                          onClick={() => elegirLigaMenu(nombre)}
                          style={{
                            display: "grid", gridTemplateColumns: "72px 1fr",
                            columnGap: 10, alignItems: "baseline",
                            width: "100%", textAlign: "left",
                            background: "transparent", border: "none", cursor: "pointer",
                            fontSize: 13, fontWeight: 600,
                            padding: "11px 10px", borderRadius: 8,
                          }}
                        >
                          {pais ? (
                            <>
                              <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{pais}</span>
                              <span style={{ color: C.blue, whiteSpace: "nowrap" }}>{liga}</span>
                            </>
                          ) : (
                            <span style={{ gridColumn: "1 / -1", color: C.blue, whiteSpace: "nowrap" }}>{liga}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 920, margin: "0 auto", padding: "24px 16px" }}>

        {mainTab === "historial" && <Historial />}

        {mainTab === "analizar" && (
          <>
            {bloqueEstado}

            <Calendario
              onAnalizar={(p, ligas) => {
                setLigasDelDia(ligas || []);
                analyze({ local: p.local, visitante: p.visitante, fixtureId: p.id, timestamp: p.timestamp });
              }}
              onLigasPorDia={setLigasPorDia}
              analizandoId={analizandoId}
              diaSel={diaSel}
              onDiaSel={setDiaSel}
              objetivoScroll={objetivoScroll}
              onObjetivoCumplido={() => setObjetivoScroll(null)}
            />
          </>
        )}

        {/* VISTA DEDICADA DEL ANALISIS ───────────────────────────────
            Se entra al arrancar analyze(), no al terminar: asi el progreso
            y cualquier fallo se ven aqui en vez de en la pantalla anterior.
            `data` vive en este componente, de modo que cambiar de vista no
            pierde el analisis. */}
        {mainTab === "analisis" && (
          <>
            <button
              onClick={volverAlCalendario}
              style={{
                background: C.card2, color: C.text, border: `1px solid ${C.border}`,
                borderRadius: 8, padding: "9px 16px", fontWeight: 700, fontSize: 13,
                cursor: "pointer", marginBottom: 18,
              }}
            >
              ← Volver
            </button>

            {bloqueEstado}

            {/* El movil va sin panel por ahora (estilo propio en otro paso):
                la media query lo saca del flujo y el contenido ocupa todo. */}
            <style>{`@media (max-width: 767px) { .panel-ligas { display: none; } }`}</style>
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
              {ligasDelDia.length > 0 && (
                <div
                  className="panel-ligas"
                  style={{
                    flex: "0 0 224px", background: C.card,
                    border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px",
                    position: "sticky", top: 12,
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.dim, letterSpacing: ".06em", marginBottom: 10 }}>
                    LIGAS DEL DIA
                  </div>
                  {ligasDelDia.map((nombre) => {
                    // Dos columnas alineadas: pais | liga. El separador " · "
                    // viene de los nombres de LIGAS; los torneos ("Copa
                    // Libertadores") no lo llevan y ocupan la fila entera.
                    const sep = nombre.indexOf(" · ");
                    const pais = sep >= 0 ? nombre.slice(0, sep) : null;
                    const liga = sep >= 0 ? nombre.slice(sep + 3) : nombre;
                    return (
                      <button
                        key={nombre}
                        onClick={() => irALiga(nombre)}
                        style={{
                          // La columna de pais es FIJA para que las ligas
                          // queden alineadas entre filas; con "auto" cada
                          // boton mediria la suya y bailarian.
                          display: "grid", gridTemplateColumns: "66px 1fr",
                          columnGap: 8, alignItems: "baseline",
                          width: "100%", textAlign: "left",
                          background: "transparent", border: "none", cursor: "pointer",
                          fontSize: 12, fontWeight: 600,
                          padding: "6px 4px", borderRadius: 6,
                        }}
                      >
                        {pais ? (
                          <>
                            <span style={{ color: C.muted, whiteSpace: "nowrap" }}>{pais}</span>
                            <span style={{ color: C.blue, whiteSpace: "nowrap" }}>{liga}</span>
                          </>
                        ) : (
                          <span style={{ gridColumn: "1 / -1", color: C.blue, whiteSpace: "nowrap" }}>{liga}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              <div style={{ flex: 1, minWidth: 0 }}>
            {data && (
              <>
                {/* VEREDICTO PRINCIPAL */}
                <div style={{ background: `linear-gradient(135deg, #0d2218, #0f2d1a, #122d20)`, border: `2px solid ${C.green}44`, borderRadius: 14, padding: "22px", marginBottom: 20 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    <Badge color={C.accent}>🏆 MEJOR APUESTA</Badge>
                    <RiskBadge risk={data.top_apuesta?.nivel_riesgo} />
                    <Badge color={data.top_apuesta?.cuota_fuente?.includes("Bet365") ? C.blue : C.muted}>{data.top_apuesta?.cuota_fuente}</Badge>
                  </div>
                  <div style={{ fontWeight: 900, fontSize: 20, color: C.green, marginBottom: 4 }}>{data.top_apuesta?.mercado}</div>
                  <div style={{ fontSize: 14, color: C.muted, marginBottom: 16 }}>{data.top_apuesta?.descripcion}</div>
                  <div style={{ fontStyle: "italic", fontSize: 13, color: C.dim, marginBottom: 20, lineHeight: 1.6 }}>{data.top_apuesta?.razon_ejecutiva}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                    {[
                      { l: "Cuota", v: `x${data.top_apuesta?.cuota?.toFixed(2)}`, c: C.accent },
                      { l: "Prob. real", v: `${data.top_apuesta?.prob_real}%`, c: C.green },
                      { l: "Confianza", v: `${data.top_apuesta?.nivel_confianza}%`, c: C.blue },
                      { l: "Valor (EV)", v: `+${((data.top_apuesta?.ev || 0) * 100).toFixed(1)}%`, c: C.purple },
                    ].map(({ l, v, c }) => (
                      <div key={l} style={{ background: "#ffffff11", borderRadius: 8, padding: "10px", textAlign: "center" }}>
                        <div style={{ fontSize: 20, fontWeight: 800, color: c }}>{v}</div>
                        <div style={{ fontSize: 10, color: C.dim, marginTop: 3 }}>{l}</div>
                      </div>
                    ))}
                  </div>

                  {/* ── STAKE SUGERIDO — solo admin ── */}
                  {!IS_USER_MODE && (() => {
                    const sk = calcStake(data.top_apuesta?.ev, data.top_apuesta?.nivel_confianza);
                    const monto = ((bank * sk.pct) / 100).toFixed(2);
                    return (
                      <div style={{ marginTop: 14, background: "#ffffff08", border: `1px solid ${sk.color}55`, borderRadius: 10, padding: "14px 16px" }}>
                        <div style={{ fontSize: 10, color: C.muted, fontWeight: 700, letterSpacing: 1, marginBottom: 10 }}>💰 STAKE SUGERIDO</div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ fontSize: 36, fontWeight: 900, color: sk.color, lineHeight: 1 }}>{sk.pct}%</div>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 800, color: sk.color }}>{sk.label}</div>
                              <div style={{ fontSize: 11, color: C.muted }}>{sk.desc}</div>
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 28, fontWeight: 900, color: sk.color }}>${monto}</div>
                            <div style={{ fontSize: 11, color: C.dim }}>de tu bank actual</div>
                          </div>
                        </div>
                        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>🏦 Bank:</span>
                          <input
                            type="number"
                            value={bank || ""}
                            onChange={e => setBank(parseFloat(e.target.value) || 0)}
                            onFocus={e => e.target.select()}
                            min="0"
                            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text, fontSize: 13, fontWeight: 600 }}
                          />
                          <span style={{ fontSize: 11, color: sk.color, fontWeight: 700, flexShrink: 0 }}>EV +{((data.top_apuesta?.ev||0)*100).toFixed(0)}% · {data.top_apuesta?.nivel_confianza}% conf</span>
                        </div>
                        <div style={{ marginTop: 10, fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                          📊 Stake calculado con el modelo de gestión de riesgo de BetFut basado en EV y nivel de confianza
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* INFO PARTIDO */}
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 20px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>{data.partido.local}</div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: C.accent, fontWeight: 900 }}>VS</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{data.partido.competicion}</div>
                    <div style={{ fontSize: 10, color: C.dim }}>{data.partido.fecha}</div>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 16, textAlign: "right" }}>{data.partido.visitante}</div>
                </div>

                {/* TABS ANÁLISIS */}
                <div style={{ display: "flex", gap: 4, marginBottom: 20, background: C.card, borderRadius: 10, padding: 4, border: `1px solid ${C.border}` }}>
                  {([["mercados", "📌 Mercados"], ["factores", "⚖️ Factores"], ["bajas", "🏥 Bajas"], ["graficas", "📊 Gráficas"], ...(!IS_USER_MODE ? [["post", "📱 Post"]] : [])]).map(([k, l]) => (
                    <button key={k} onClick={() => setTab(k)} style={{
                      flex: 1, background: tab === k ? C.accent : "transparent",
                      color: tab === k ? "#fff" : C.muted,
                      border: "none", borderRadius: 7, padding: "8px 4px",
                      fontWeight: tab === k ? 800 : 500, fontSize: 12, cursor: "pointer"
                    }}>{l}</button>
                  ))}
                </div>

                {/* MERCADOS TAB */}
                {tab === "mercados" && (
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: C.accent, marginBottom: 14 }}>🥇 Top 3 Mercados por Valor Esperado</div>
                    <div style={{ display: "grid", gap: 14, marginBottom: 24 }}>
                      {top3.map(m => <MercadoCard key={m.nombre} m={m} partido={data.partido} rank={m.ranking} bank={bank} onGuardar={guardarEnHistorial} guardadoId={guardadoId} />)}
                    </div>
                    {otros.length > 0 && (
                      <>
                        <div style={{ fontWeight: 600, fontSize: 13, color: C.dim, marginBottom: 12 }}>📋 Otros mercados analizados (sin suficiente EV)</div>
                        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                          {otros.map((m, i) => (
                            <div key={m.nombre} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: i < otros.length - 1 ? `1px solid ${C.border}` : "none" }}>
                              <div>
                                <div style={{ fontSize: 13, color: C.text }}>{iconoMercado(m.nombre)} {m.nombre}</div>
                                <div style={{ fontSize: 11, color: C.dim }}>{m.descripcion}</div>
                              </div>
                              <div style={{ textAlign: "right", flexShrink: 0 }}>
                                <div style={{ fontSize: 15, fontWeight: 700, color: C.muted }}>x{m.cuota?.toFixed(2)}</div>
                                <div style={{ fontSize: 10, color: m.ev > 0 ? C.green : C.red }}>EV: {m.ev > 0 ? "+" : ""}{((m.ev || 0) * 100).toFixed(1)}%</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* FACTORES TAB */}
                {tab === "factores" && (
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 20 }}>
                      {[
                        { l: `${data.partido.local} gana`, v: data.probabilidades_1x2?.victoria_local, c: C.blue },
                        { l: "Empate", v: data.probabilidades_1x2?.empate, c: C.muted },
                        { l: `${data.partido.visitante} gana`, v: data.probabilidades_1x2?.victoria_visitante, c: C.accent },
                      ].map(({ l, v, c }) => (
                        <div key={l} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px", textAlign: "center" }}>
                          <div style={{ fontSize: 24, fontWeight: 800, color: c }}>{v}%</div>
                          <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>{l}</div>
                          <div style={{ marginTop: 6, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ height: "100%", width: `${v}%`, background: c, borderRadius: 2 }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px", marginBottom: 16 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14, color: C.accent }}>🔑 Puntos Clave</div>
                      {data.puntos_clave?.map((p, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8, padding: "10px 12px", background: C.card2, borderRadius: 8, borderLeft: `3px solid ${C.accent}` }}>
                          <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{p}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px" }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: C.blue }}>⚖️ Factor a Factor</div>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.dim, marginBottom: 12 }}>
                        <span style={{ color: C.blue }}>{data.partido.local}</span>
                        <span style={{ color: C.accent }}>{data.partido.visitante}</span>
                      </div>
                      {data.factores?.map(f => (
                        <div key={f.nombre} style={{ marginBottom: 14 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 4 }}>
                            <span>{f.icono} {f.nombre}</span>
                            <span>{f.local?.toFixed(1)} / {f.visitante?.toFixed(1)}</span>
                          </div>
                          <ScoreBar local={f.local} visitante={f.visitante} />
                          <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{f.detalle}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* BAJAS TAB */}
                {tab === "bajas" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    {[
                      { team: data.partido.local, bajas: data.bajas?.local, estado: data.bajas?.estado_plantilla_local, color: C.blue },
                      { team: data.partido.visitante, bajas: data.bajas?.visitante, estado: data.bajas?.estado_plantilla_visitante, color: C.accent }
                    ].map(({ team, bajas, estado, color }) => (
                      <div key={team}>
                        <div style={{ fontWeight: 700, fontSize: 13, color, marginBottom: 10 }}>
                          {team} <span style={{ fontSize: 11, color: C.dim, fontWeight: 400 }}>— {estado}</span>
                        </div>
                        {bajas?.length > 0
                          ? bajas.map((b, i) => <BajaCard key={i} b={b} />)
                          : <div style={{ color: C.green, fontSize: 13, background: C.greenDim + "33", borderRadius: 8, padding: "12px", textAlign: "center" }}>✅ Sin bajas confirmadas públicamente</div>
                        }
                      </div>
                    ))}
                  </div>
                )}

                {/* GRÁFICAS TAB */}
                {tab === "graficas" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                    {/* Barras EV por mercado */}
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px" }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14 }}>💰 Valor Esperado (EV) por Mercado</div>
                      <ResponsiveContainer width="100%" height={Math.max(200, (data.mercados_analizados?.length || 5) * 38)}>
                        <BarChart layout="vertical" data={data.mercados_analizados?.map(m => ({ name: m.nombre, ev: parseFloat(((m.ev || 0) * 100).toFixed(1)), recomendado: m.recomendado }))} margin={{ top: 5, right: 60, left: 120, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                          <XAxis type="number" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickFormatter={v => `${v > 0 ? "+" : ""}${v}%`} />
                          <YAxis type="category" dataKey="name" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} width={115} />
                          <Tooltip contentStyle={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text }} formatter={v => [`${v > 0 ? "+" : ""}${v}%`, "EV"]} />
                          <Bar dataKey="ev" radius={[0, 4, 4, 0]}>
                            {data.mercados_analizados?.map((m, i) => (
                              <Cell key={i} fill={m.recomendado ? C.green : m.ev > 0 ? C.blue : C.red} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Prob vs Implícita - top 3 */}
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px" }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14 }}>📊 Prob. Real vs Prob. Implícita (Top 3)</div>
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={top3.map(m => ({ name: m.nombre.slice(0, 20), real: m.prob_real, implicita: m.prob_implicita }))} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                          <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} />
                          <YAxis tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickFormatter={v => `${v}%`} />
                          <Tooltip contentStyle={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text }} formatter={v => `${v}%`} />
                          <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
                          <Bar dataKey="real" name="Prob. real" fill={C.green} radius={[4, 4, 0, 0]} />
                          <Bar dataKey="implicita" name="Prob. implícita" fill={C.dim} radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Torta probabilidades */}
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px" }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14 }}>🥧 Probabilidades 1X2</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                        <ResponsiveContainer width="55%" height={200}>
                          <PieChart>
                            <Pie data={[
                              { name: `${data.partido.local} gana`, value: data.probabilidades_1x2?.victoria_local },
                              { name: "Empate", value: data.probabilidades_1x2?.empate },
                              { name: `${data.partido.visitante} gana`, value: data.probabilidades_1x2?.victoria_visitante },
                            ]} cx="50%" cy="50%" outerRadius={85} innerRadius={45} paddingAngle={3} dataKey="value">
                              {PIE_COLORS.map((c, i) => <Cell key={i} fill={c} />)}
                            </Pie>
                            <Tooltip contentStyle={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8 }} formatter={v => `${v}%`} />
                          </PieChart>
                        </ResponsiveContainer>
                        <div style={{ flex: 1 }}>
                          {[
                            { l: `${data.partido.local} gana`, v: data.probabilidades_1x2?.victoria_local, c: PIE_COLORS[0] },
                            { l: "Empate", v: data.probabilidades_1x2?.empate, c: PIE_COLORS[1] },
                            { l: `${data.partido.visitante} gana`, v: data.probabilidades_1x2?.victoria_visitante, c: PIE_COLORS[2] },
                          ].map(({ l, v, c }) => (
                            <div key={l} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                              <div style={{ width: 10, height: 10, background: c, borderRadius: 2 }} />
                              <div style={{ fontSize: 12, color: C.muted, flex: 1 }}>{l}</div>
                              <div style={{ fontWeight: 700, color: C.text }}>{v}%</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Radar */}
                    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px" }}>
                      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 14 }}>🕸️ Radar Global de Factores</div>
                      <ResponsiveContainer width="100%" height={280}>
                        <RadarChart data={data.factores?.map(f => ({ subject: f.nombre, local: f.local, visitante: f.visitante }))}>
                          <PolarGrid stroke={C.border} />
                          <PolarAngleAxis dataKey="subject" tick={{ fill: C.muted, fontSize: 10 }} />
                          <Radar name={data.partido.local} dataKey="local" stroke={C.blue} fill={C.blue} fillOpacity={0.2} />
                          <Radar name={data.partido.visitante} dataKey="visitante" stroke={C.accent} fill={C.accent} fillOpacity={0.2} />
                          <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
                          <Tooltip contentStyle={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text }} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* POST TAB */}
                {!IS_USER_MODE && tab === "post" && (
                  <div>
                    <div style={{ display: "flex", gap: 4, marginBottom: 16, background: C.card, borderRadius: 8, padding: 4, border: `1px solid ${C.border}` }}>
                      {[["telegram", "📱 Telegram"], ["whatsapp", "💬 WhatsApp"]].map(([k, l]) => (
                        <button key={k} onClick={() => setPostMode(k)} style={{
                          flex: 1, background: postMode === k ? (k === "telegram" ? "linear-gradient(135deg,#1565c0,#2196F3)" : "linear-gradient(135deg,#1a8a45,#25D366)") : "transparent",
                          color: postMode === k ? "#fff" : C.muted, border: "none", borderRadius: 6,
                          padding: "8px", fontWeight: 700, fontSize: 13, cursor: "pointer"
                        }}>{l}</button>
                      ))}
                    </div>
                    <div style={{ background: postMode === "telegram" ? "#1a2535" : "#1a2520", border: `1px solid ${postMode === "telegram" ? "#2196F344" : "#25D36644"}`, borderRadius: 12, padding: "18px", maxWidth: 380, margin: "0 auto" }}>
                      <div style={{ fontSize: 11, color: C.dim, marginBottom: 10 }}>Vista previa {postMode === "telegram" ? "Telegram" : "WhatsApp"}</div>
                      <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, color: C.text, lineHeight: 1.7, fontFamily: "inherit", margin: 0 }}>
                        {postMode === "telegram" ? data.post_telegram : data.post_whatsapp}
                      </pre>
                    </div>
                    <button onClick={() => copy(postMode === "telegram" ? data.post_telegram : data.post_whatsapp)} style={{
                      width: "100%", marginTop: 14, background: copied ? C.green : "transparent",
                      color: copied ? "#000" : C.muted, border: `1px solid ${C.border}`,
                      borderRadius: 8, padding: "11px", fontWeight: 700, fontSize: 13, cursor: "pointer"
                    }}>{copied ? "✅ ¡Copiado!" : "📋 Copiar"}</button>
                  </div>
                )}

              </>
            )}
              </div>
            </div>
          </>
        )}

        {/* PLANES */}
        {mainTab === "analizar" && !loading && (
          <div style={{ marginTop: 32, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px" }}>
            <div style={{ textAlign: "center", marginBottom: 18 }}>
              <Badge color={C.accent} size="md">👑 PLANES DE ACCESO</Badge>
              <div style={{ fontWeight: 800, fontSize: 17, marginTop: 10 }}>Elige tu nivel</div>
            </div>
            {/* Grid responsive: 1 col en móvil, 3 en desktop */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, width: "100%", boxSizing: "border-box" }}>
              {[
                { n: "FREE", p: "$0/día", c: C.green, feats: ["1 Análisis de partido gratis diario", "1 Pronóstico gratis diario", "Manejo de Historial", "Balance de apuestas", "Excel Exportable"] },
                { n: "PREMIUM", p: "$4.99/día", c: C.accent, feats: ["3 Análisis de partidos diarios", "1 Pronóstico diario premium + 1 Pronóstico gratis diario", "Manejo de Historial", "Balance de apuestas", "Excel Exportable", "Acceso canal Telegram/WhatsApp privado", "Acceso al método ganador probado"], hi: true },
                { n: "VIP", p: "$39.99/mes", c: C.blue, feats: ["Análisis de partidos ilimitado", "Todos los pronósticos VIP, Premium y gratis", "Manejo de Historial", "Balance de apuestas", "Excel Exportable", "Acceso canal Telegram/WhatsApp privado", "Acceso al método ganador probado", "Acompañamiento en el método ganador", "Soporte personalizado"] },
              ].map(plan => (
                <div key={plan.n} style={{ background: C.card2, border: `1px solid ${plan.hi ? plan.c + "66" : C.border}`, borderRadius: 10, padding: "16px", boxSizing: "border-box", minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: plan.c, marginBottom: 6 }}>{plan.n}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 12 }}>{plan.p}</div>
                  {plan.feats.map(f => <div key={f} style={{ fontSize: 11, color: C.muted, marginBottom: 5, display: "flex", gap: 6 }}><span style={{ color: C.green, flexShrink: 0 }}>✓</span>{f}</div>)}
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center", fontSize: 11, color: C.dim, marginTop: 14 }}>⚠️ Sugerencias basadas en análisis con IA. Juega responsablemente.</div>
          </div>
        )}

      </div>
    </div>
  );
}
