import { useState, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis, Legend,
  LineChart, Line
} from "recharts";

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
  blue:     "#60a5fa",
  purple:   "#c084fc",
  text:     "#e2f0fb",
  muted:    "#7eb8d4",
  dim:      "#4a7090",
};

const MERCADOS_ICONS = {
  "1X2": "🏆", "Doble Oportunidad": "🔄", "Ambos Marcan (BTTS)": "⚽",
  "Más de 2.5 Goles": "📈", "Menos de 2.5 Goles": "📉",
  "Más de 1.5 Goles": "🎯", "Hándicap Asiático": "⚖️",
  "Córners +9.5": "📐", "Tarjetas +3.5": "🟨",
  "Gana en el Descanso": "🕐", "Primer Gol Antes Min 30": "⚡",
  "HT/FT": "📊"
};

const SYSTEM_PROMPT = `Eres un analista de apuestas deportivas. Analiza el partido y devuelve SOLO el bloque JSON exacto.

REGLA ABSOLUTA: Tu respuesta debe empezar con ---JSON_START--- y terminar con ---JSON_END---. Nada mas.

El JSON tiene exactamente esta estructura (reemplaza los valores de ejemplo con datos reales del partido):
---JSON_START---
{"partido":{"local":"EQUIPO_LOCAL","visitante":"EQUIPO_VISITANTE","competicion":"LIGA","fecha":"FECHA","estadio":"ESTADIO"},"mercados_analizados":[{"nombre":"1X2 Victoria Local","descripcion":"gana el equipo local","cuota":1.45,"cuota_fuente":"Bet365","prob_real":72,"prob_implicita":69,"ev":0.04,"nivel_confianza":70,"recomendado":false,"ranking":4,"razon":"cuota sin valor suficiente"},{"nombre":"Doble Oportunidad 1X","descripcion":"local gana o empata","cuota":1.20,"cuota_fuente":"Bet365","prob_real":85,"prob_implicita":83,"ev":0.02,"nivel_confianza":82,"recomendado":false,"ranking":5,"razon":"sin valor por cuota baja"},{"nombre":"BTTS Si","descripcion":"ambos equipos marcan","cuota":1.75,"cuota_fuente":"Bet365","prob_real":60,"prob_implicita":57,"ev":0.05,"nivel_confianza":60,"recomendado":false,"ranking":6,"razon":"valor moderado"},{"nombre":"Mas de 2.5 Goles","descripcion":"partido termina con 3 o mas goles","cuota":1.65,"cuota_fuente":"Bet365","prob_real":65,"prob_implicita":61,"ev":0.07,"nivel_confianza":63,"recomendado":false,"ranking":7,"razon":"buen promedio goles"},{"nombre":"Menos de 2.5 Goles","descripcion":"partido termina con 2 o menos goles","cuota":2.10,"cuota_fuente":"Bet365","prob_real":35,"prob_implicita":48,"ev":-0.27,"nivel_confianza":35,"recomendado":false,"ranking":8,"razon":"sin valor"},{"nombre":"Mas de 1.5 Goles","descripcion":"partido termina con 2 o mas goles","cuota":1.25,"cuota_fuente":"Bet365","prob_real":82,"prob_implicita":80,"ev":0.03,"nivel_confianza":80,"recomendado":true,"ranking":3,"razon":"alta probabilidad cuota baja"},{"nombre":"Handicap Asiatico -1.5","descripcion":"equipo local gana por 2 o mas","cuota":1.90,"cuota_fuente":"Bet365","prob_real":58,"prob_implicita":53,"ev":0.10,"nivel_confianza":65,"recomendado":true,"ranking":2,"razon":"buen valor por diferencia nivel"},{"nombre":"Corners mas de 9.5","descripcion":"mas de 9 corners en el partido","cuota":1.85,"cuota_fuente":"Estimada","prob_real":62,"prob_implicita":54,"ev":0.15,"nivel_confianza":68,"recomendado":true,"ranking":1,"razon":"mayor valor esperado del partido"}],"top_apuesta":{"mercado":"Corners mas de 9.5","descripcion":"mas de 9 corners en el partido","cuota":1.85,"cuota_fuente":"Estimada","prob_real":62,"prob_implicita":54,"ev":0.15,"nivel_confianza":68,"nivel_riesgo":"MEDIO","razon_ejecutiva":"Este mercado ofrece el mayor valor esperado del partido con probabilidad real superior a la implicita en la cuota."},"probabilidades_1x2":{"victoria_local":55,"empate":25,"victoria_visitante":20},"bajas":{"local":[{"nombre":"Jugador Ejemplo","posicion":"DC","es_titular":true}],"visitante":[]},"factores":{"forma_local":70,"forma_visitante":40,"presion_local":60,"motivacion_local":75,"motivacion_visitante":50,"cansancio_local":25,"cansancio_visitante":35},"puntos_clave":["El equipo local lleva 8 partidos invicto en casa","El visitante no gana fuera desde hace 5 jornadas","Diferencia de 20 puntos en la tabla"],"analisis_general":"El equipo local es favorito claro. El mercado de corners ofrece el mejor valor del encuentro."}
---JSON_END---

INSTRUCCION FINAL: Copia exactamente esa estructura JSON pero con los datos REALES del partido. No uses comillas dobles dentro de los valores de texto. Usa solo letras, numeros, espacios y puntos en los campos de texto.`;


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

function MercadoCard({ m, partido, rank, bank = 0 }) {
  const rankColors = { 1: C.accent, 2: C.blue, 3: C.dim };
  const rankLabels = { 1: "🥇 MEJOR VALOR", 2: "🥈 ALTERNATIVA", 3: "🥉 OPCIÓN 3" };
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
          <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{MERCADOS_ICONS[m.nombre] || "📌"} {m.nombre}</div>
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
      if (r) setRecords(JSON.parse(r));
      else setRecords([]);
    } catch { setRecords([]); }
    setLoaded(true);
  };

  useEffect(() => {
    loadFromStorage();
    window.addEventListener("storage", loadFromStorage);
    return () => window.removeEventListener("storage", loadFromStorage);
  }, []);

  const save = async (newRecs) => {
    try { localStorage.setItem("betscore_historial", JSON.stringify(newRecs)); } catch {}
    setRecords(newRecs);
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
      const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">\n<Styles>${styles}</Styles>\n<Worksheet ss:Name="BetScore IA">\n<Table>\n  <Column ss:Width="100"/><Column ss:Width="190"/><Column ss:Width="90"/><Column ss:Width="160"/><Column ss:Width="55"/><Column ss:Width="75"/><Column ss:Width="80"/><Column ss:Width="90"/>\n  <Row ss:Height="20"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>
  <Row ss:Height="52">
    <Cell ss:StyleID="titleBall" ss:MergeAcross="1"><Data ss:Type="String">&#x26BD;</Data></Cell>
    <Cell ss:StyleID="title"     ss:MergeAcross="5"><Data ss:Type="String">BetScore IA  |  HISTORIAL DE APUESTAS</Data></Cell>
  </Row>\n  <Row ss:Height="18"><Cell ss:StyleID="sub" ss:MergeAcross="7"><Data ss:Type="String">Exportado el ${esc(new Date().toLocaleString("es-CO"))} - betscore.app - Analisis de apuestas con IA</Data></Cell></Row>\n  <Row ss:Height="8"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>\n  <Row ss:Height="20">${sumRows.map(([l])=>`<Cell ss:StyleID="sumLbl"><Data ss:Type="String">${esc(l)}</Data></Cell>`).join('')}</Row>\n  <Row ss:Height="30">${sumRows.map(([,v,s])=>`<Cell ss:StyleID="${s}"><Data ss:Type="String">${esc(v)}</Data></Cell>`).join('')}</Row>\n  <Row ss:Height="8"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>\n  <Row ss:Height="24">${['FECHA','PARTIDO','CATEGORIA','MERCADO JUGADO','CUOTA','MONTO ($)','RESULTADO','GANANCIA ($)'].map(h=>`<Cell ss:StyleID="colH"><Data ss:Type="String">${h}</Data></Cell>`).join('')}</Row>\n  ${dataRows}\n  <Row ss:Height="8"><Cell ss:StyleID="gap" ss:MergeAcross="7"><Data ss:Type="String"> </Data></Cell></Row>\n  <Row ss:Height="18"><Cell ss:StyleID="foot" ss:MergeAcross="7"><Data ss:Type="String">Las apuestas son sugerencias basadas en analisis estadistico con IA. Juega con responsabilidad. BetScore IA - betscore.app</Data></Cell></Row>\n</Table>\n</Worksheet>\n</Workbook>`;
      const blob=new Blob([xml],{type:'text/xml;charset=UTF-8'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url; a.download=`BetIQ_${new Date().toLocaleDateString('es-CO').replace(/\//g,'-')}.xml`;
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
export default function BetIQProV3() {
  // Fijar color de fondo en body para evitar fondo blanco en overscroll móvil
  if (typeof document !== "undefined") {
    document.body.style.background = "#0d1b2a";
    document.body.style.margin = "0";
    document.documentElement.style.background = "#0d1b2a";
  }
  const [form, setForm] = useState({ local: "", visitante: "" });
  const [bank, setBank] = useState(1000);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("mercados");
  const [postMode, setPostMode] = useState("telegram");
  const [copied, setCopied] = useState(false);
  const [mainTab, setMainTab] = useState("analizar");

  const analyze = async () => {
    if (!form.local || !form.visitante) return;
    setLoading(true); setError(""); setData(null);
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
            headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ local: form.local, visitante: form.visitante, fecha: form.fecha }),
        });

        const footballText = await footballRes.text();

        if (!footballText.trimStart().startsWith("<") && footballRes.ok) {
          footballData = JSON.parse(footballText);
        }
      } catch { /* fallback a web search */ }

      if (footballData?.encontrado) {
        // Construir resumen estructurado con datos reales de API-Football
        const f = footballData;
        const odds_bet365 = f.odds?.find(o => o.mercado === "Match Winner")?.valores || [];
        const cuota_local = odds_bet365.find(v => v.value === "Home")?.odd || "No disponible";
        const cuota_empate = odds_bet365.find(v => v.value === "Draw")?.odd || "No disponible";
        const cuota_visit = odds_bet365.find(v => v.value === "Away")?.odd || "No disponible";

        const formatLesionados = (lista) =>
          lista.length > 0
            ? lista.map(l => `${l.nombre} (${l.posicion || "N/D"}) — ${l.motivo || "Lesionado"}`).join(", ")
            : "Sin lesionados confirmados en API-Football";

        searchData = `DATOS REALES DE API-FOOTBALL (verificados):

PARTIDO: ${f.fixture?.local?.nombre} vs ${f.fixture?.visitante?.nombre}
LIGA: ${f.fixture?.liga} (${f.fixture?.pais})
FECHA: ${f.fixture?.fecha}
ESTADIO: ${f.fixture?.estadio}, ${f.fixture?.ciudad}
ÁRBITRO: ${f.fixture?.arbitro || "Por confirmar"}

CUOTAS REALES BET365:
- ${f.fixture?.local?.nombre} gana: ${cuota_local}
- Empate: ${cuota_empate}
- ${f.fixture?.visitante?.nombre} gana: ${cuota_visit}

MERCADOS BET365 (top 5):
${(f.odds || []).slice(0, 5).map(o => "- " + (o.mercado||"") + ": " + (o.valores||[]).slice(0,4).map(v => (v.value||"") + "=" + (v.odd||"")).join(", ")).join("\n") || "Sin datos"}
LESIONADOS ${f.fixture?.local?.nombre?.toUpperCase()}:
${formatLesionados(f.lesionados_local)}

LESIONADOS ${f.fixture?.visitante?.nombre?.toUpperCase()}:
${formatLesionados(f.lesionados_visitante)}

STATS ${f.fixture?.local?.nombre?.toUpperCase()}:
Forma:${f.stats_local?.forma||"N/D"} PJ:${f.stats_local?.partidos_jugados||0} G:${f.stats_local?.ganados||0} E:${f.stats_local?.empatados||0} P:${f.stats_local?.perdidos||0} GF:${f.stats_local?.goles_favor||0} GC:${f.stats_local?.goles_contra||0} Pos:${f.posicion_local?.pos||"N/D"} Pts:${f.posicion_local?.pts||"N/D"}

STATS ${f.fixture?.visitante?.nombre?.toUpperCase()}:
Forma:${f.stats_visitante?.forma||"N/D"} PJ:${f.stats_visitante?.partidos_jugados||0} G:${f.stats_visitante?.ganados||0} E:${f.stats_visitante?.empatados||0} P:${f.stats_visitante?.perdidos||0} GF:${f.stats_visitante?.goles_favor||0} GC:${f.stats_visitante?.goles_contra||0} Pos:${f.posicion_visitante?.pos||"N/D"} Pts:${f.posicion_visitante?.pts||"N/D"}

FUENTE: API-Football (datos oficiales en tiempo real)`;

        setProgress("✅ Datos reales obtenidos — Generando análisis con IA...");
      } else {
        // Sin datos de API-Football: Claude analiza con conocimiento propio
        setProgress("🧠 Analizando con conocimiento de IA...");
        searchData = `Partido: ${form.local} vs ${form.visitante} | Fecha: "próximos días".
Partido no encontrado en API-Football para esa fecha. Analiza basandote en tu conocimiento del historial,
forma reciente, estadísticas y contexto de ambos equipos. Usa cuotas estimadas realistas.`;
      }

      // PASO 2 — JSON con delimitadores explícitos — max_tokens suficiente sin exceder
      setProgress("⚖️ Calculando EV en 8+ mercados...");
      const jsonRaw = await apiCall(
        SYSTEM_PROMPT,
        [{
          role: "user",
          content: `Partido: ${form.local} vs ${form.visitante} | Fecha: ${"Próximos días"}

DATOS REALES DE API-FOOTBALL:
${searchData.slice(0, 1200)}

FORMATO: responde SOLO con ---JSON_START--- {json} ---JSON_END---. Sin texto extra. Analiza 8 mercados. Cuota minima #1: 1.40.`
        }],
        false,
        4000,
        120000
      );

      clearInterval(iv);

      // Extracción por delimitadores — no falla aunque haya texto alrededor
      let raw = jsonRaw;
      const startMarker = "---JSON_START---";
      const endMarker = "---JSON_END---";
      const startIdx = raw.indexOf(startMarker);
      const endIdx = raw.lastIndexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        raw = raw.slice(startIdx + startMarker.length, endIdx).trim();
      } else {
        raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
        const fb = raw.indexOf("{");
        const lb = raw.lastIndexOf("}");
        if (fb === -1 || lb === -1) throw new Error("No se encontró JSON en la respuesta del modelo");
        raw = raw.slice(fb, lb + 1);
      }

      // Limpiar JSON — fix newlines y comillas no escapadas dentro de strings
      const cleanJson = (str) => {
        let result = "";
        let inString = false;
        let i = 0;
        while (i < str.length) {
          const ch = str[i];
          if (inString) {
            if (ch === "\\" && i + 1 < str.length) {
              result += ch + str[i + 1]; i += 2; continue;
            }
            if (ch === '"') {
              // Detectar si es comilla de cierre mirando el siguiente char no-espacio
              let j = i + 1;
              while (j < str.length && str[j] === " ") j++;
              const nx = str[j];
              if (nx === ":" || nx === "," || nx === "}" || nx === "]" || nx === "\n" || nx === "\r" || j >= str.length) {
                inString = false; result += ch;
              } else {
                result += '\\"'; // escapar comilla interna
              }
              i++; continue;
            }
            if (ch === "\n" || ch === "\r" || ch === "\t") { result += " "; i++; continue; }
            result += ch;
          } else {
            if (ch === '"') inString = true;
            result += ch;
          }
          i++;
        }
        return result;
      };

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Intento 2: limpiar y reintentar
        try {
          parsed = JSON.parse(cleanJson(raw));
        } catch {
          // Intento 3: extraer solo hasta el último } válido
          let depth = 0; let lastValid = -1;
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === "{") depth++;
            if (raw[i] === "}") { depth--; if (depth === 0) { lastValid = i; break; } }
          }
          if (lastValid === -1) throw new Error("JSON inválido en la respuesta del modelo");
          parsed = JSON.parse(cleanJson(raw.slice(0, lastValid + 1)));
        }
      }

      // Normalizar factores: si es objeto {forma_local:70,...} → convertir a array para el UI
      if (parsed.factores && !Array.isArray(parsed.factores)) {
        const f = parsed.factores;
        parsed.factores = [
          { nombre: "Forma", icono: "📈", local: f.forma_local || 50, visitante: f.forma_visitante || 50, detalle: "" },
          { nombre: "Presión", icono: "🏟️", local: f.presion_local || 50, visitante: f.presion_visitante || f.presion_local || 50, detalle: "" },
          { nombre: "Motivación", icono: "🎯", local: f.motivacion_local || 50, visitante: f.motivacion_visitante || 50, detalle: "" },
          { nombre: "Cansancio", icono: "😴", local: 100-(f.cansancio_local||25), visitante: 100-(f.cansancio_visitante||25), detalle: "" },
        ];
      }
      if (!parsed.factores) parsed.factores = [];

      // Normalizar bajas: si son strings → convertir a arrays de objetos
      if (parsed.bajas) {
        const toArr = (v) => {
          if (Array.isArray(v)) return v;
          if (!v || typeof v !== "string") return [];
          const s = v.trim();
          if (!s || s.toLowerCase() === "ninguna" || s === "-" || s === "sin bajas") return [];
          return s.split(",").map(n => ({ nombre: n.trim(), posicion: "N/D", es_titular: false }));
        };
        parsed.bajas.local = toArr(parsed.bajas.local);
        parsed.bajas.visitante = toArr(parsed.bajas.visitante);
      } else {
        parsed.bajas = { local: [], visitante: [] };
      }

      // Generar posts en el cliente
      const t1 = parsed.mercados_analizados?.find(m => m.ranking === 1) || parsed.top_apuesta || {};
      const t2 = parsed.mercados_analizados?.find(m => m.ranking === 2) || {};
      const t3 = parsed.mercados_analizados?.find(m => m.ranking === 3) || {};
      const bL = parsed.bajas?.local?.map(b => `${b.nombre} (${b.posicion})`).join(", ") || "Sin bajas confirmadas";
      const bV = parsed.bajas?.visitante?.map(b => `${b.nombre} (${b.posicion})`).join(", ") || "Sin bajas confirmadas";
      const pr = parsed.probabilidades_1x2 || parsed.probabilidades || {};
      const cuota1 = (t1.cuota || parsed.top_apuesta?.cuota || 0).toFixed(2);
      const conf1 = t1.nivel_confianza || parsed.top_apuesta?.nivel_confianza || "—";
      const ev1 = ((t1.ev || 0) * 100).toFixed(1);
      const nombre1 = t1.nombre || parsed.top_apuesta?.mercado || "—";
      const desc1 = t1.descripcion || parsed.top_apuesta?.descripcion || "—";
      const fuente1 = t1.cuota_fuente || parsed.top_apuesta?.cuota_fuente || "Estimada";

      parsed.post_telegram = `🏆 *BetScore IA* — ANÁLISIS ÉLITE\n\n⚽ ${parsed.partido?.local} vs ${parsed.partido?.visitante}\n🏆 ${parsed.partido?.competicion || "Fútbol"} | ${parsed.partido?.fecha || form.fecha}\n\n━━━━━━━━━━━━━━━━━━━━\n🥇 APUESTA #1 — MAYOR VALOR\n━━━━━━━━━━━━━━━━━━━━\n🎯 ${nombre1}: ${desc1}\n💰 Cuota: ${cuota1} (${fuente1})\n📊 Confianza: ${conf1}% | EV: +${ev1}%\n\n🥈 ALTERNATIVA #2\n🎯 ${t2.nombre || "—"}: ${t2.descripcion || "—"}\n💰 Cuota: ${(t2.cuota || 0).toFixed(2)} | Confianza: ${t2.nivel_confianza || "—"}%\n\n🥉 ALTERNATIVA #3\n🎯 ${t3.nombre || "—"}: ${t3.descripcion || "—"}\n💰 Cuota: ${(t3.cuota || 0).toFixed(2)} | Confianza: ${t3.nivel_confianza || "—"}%\n\n━━━━━━━━━━━━━━━━━━━━\n🔑 PUNTOS CLAVE\n━━━━━━━━━━━━━━━━━━━━\n${(parsed.puntos_clave || []).map(p => `• ${p}`).join("\n")}\n\n🏥 Bajas ${parsed.partido?.local}: ${bL}\n🏥 Bajas ${parsed.partido?.visitante}: ${bV}\n\n⚡ Local ${pr.victoria_local}% | Empate ${pr.empate}% | Visit. ${pr.victoria_visitante}%\n\n⚠️ Solo sugerencia. Juega con responsabilidad.`;

      parsed.post_whatsapp = `🏆 *BetScore IA*\n\n⚽ *${parsed.partido?.local} vs ${parsed.partido?.visitante}*\n📅 ${parsed.partido?.fecha || form.fecha} | 🏆 ${parsed.partido?.competicion || "Fútbol"}\n\n─────────────────────\n🥇 *MEJOR APUESTA*\n─────────────────────\n🎯 *${nombre1}*\n📝 ${desc1}\n💰 Cuota: *${cuota1}* (${fuente1})\n✅ Confianza: *${conf1}%* | EV: *+${ev1}%*\n\n─────────────────────\n🥈 *ALTERNATIVAS*\n─────────────────────\n🎯 ${t2.nombre || "—"} — Cuota *${(t2.cuota || 0).toFixed(2)}*\n🎯 ${t3.nombre || "—"} — Cuota *${(t3.cuota || 0).toFixed(2)}*\n\n─────────────────────\n🔑 *PUNTOS CLAVE*\n─────────────────────\n${(parsed.puntos_clave || []).map((p, i) => `${i + 1}️⃣ ${p}`).join("\n")}\n\n🏥 *Bajas:*\n▪️ ${parsed.partido?.local}: ${bL}\n▪️ ${parsed.partido?.visitante}: ${bV}\n\n📊 Local ${pr.victoria_local}% | Empate ${pr.empate}% | Visit. ${pr.victoria_visitante}%\n\n_⚠️ Solo sugerencia. Juega responsable._`;

      setData(parsed);
      setTab("mercados");

      // ── Auto-guardar análisis en historial ──────────────────────────
      try {
        const KEY = "betscore_historial";
        let prev = [];
        try { prev = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { prev = []; }

        const newRecord = {
          id: Date.now(),
          fecha_analisis: new Date().toLocaleDateString("es-CO"),
          hora_analisis: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }),
          partido: String((parsed?.partido?.local || form.local || "") + " vs " + (parsed?.partido?.visitante || form.visitante || "")),
          local: String(parsed?.partido?.local || form.local || ""),
          visitante: String(parsed?.partido?.visitante || form.visitante || ""),
          competicion: String(parsed?.partido?.competicion || "N/D"),
          fecha_partido: String(parsed?.partido?.fecha || "Próximos días"),
          mercado_1: String(nombre1 || "—"),
          desc_1: String(desc1 || "—"),
          cuota_1: Number(parseFloat(cuota1)) || 0,
          ev_1: Number(parseFloat(ev1)) || 0,
          confianza_1: String(conf1 || "—"),
          fuente_1: String(fuente1 || "Estimada"),
          mercado_2: String(t2?.nombre || "—"),
          cuota_2: Number(t2?.cuota) || 0,
          ev_2: Number(parseFloat(((t2?.ev || 0) * 100).toFixed(1))) || 0,
          mercado_3: String(t3?.nombre || "—"),
          cuota_3: Number(t3?.cuota) || 0,
          ev_3: Number(parseFloat(((t3?.ev || 0) * 100).toFixed(1))) || 0,
          prob_local: Number(pr?.victoria_local) || 0,
          prob_empate: Number(pr?.empate) || 0,
          prob_visitante: Number(pr?.victoria_visitante) || 0,
          bajas_local: String(bL || "Sin bajas"),
          bajas_visitante: String(bV || "Sin bajas"),
          resultado: "PENDIENTE",
          apuesta_jugada: String(nombre1 || "—"),
          cuota_jugada: Number(parseFloat(cuota1)) || 0,
          monto_apostado: 0,
          ganancia_unidades: null,
          categoria: "premium",
        };

        const serialized = JSON.stringify([newRecord, ...prev]);
        localStorage.setItem(KEY, serialized);
        // Notificar al componente Historial si está montado
        window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: serialized }));
      } catch (saveErr) {
        console.error("Auto-save historial error:", saveErr);
      }
    } catch (e) {
      clearInterval(iv);
      setError("Error: " + e.message + " — Intenta de nuevo.");
    } finally { setLoading(false); setProgress(""); }
  };

  const copy = (text) => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  const inputS = {
    width: "100%", background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8,
    padding: "10px 14px", color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit"
  };

  const top3 = data?.mercados_analizados?.slice().sort((a, b) => a.ranking - b.ranking).slice(0, 3) || [];
  const otros = data?.mercados_analizados?.filter(m => !m.recomendado) || [];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter','Segoe UI',sans-serif", paddingBottom: 60, overflowX: "hidden" }}>

      {/* HEADER */}
      <div style={{ background: `linear-gradient(135deg, #0d1b2a 0%, #162436 60%, #1c2e44 100%)`, borderBottom: `1px solid ${C.border}`, padding: "18px 24px 14px" }}>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 42, height: 42, flexShrink: 0 }}>
              <svg viewBox="0 0 228 260" width="42" height="42" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <radialGradient id="hs" cx="36%" cy="28%" r="72%">
                    <stop offset="0%" stopColor="#ffffff"/>
                    <stop offset="42%" stopColor="#d8d8d8"/>
                    <stop offset="85%" stopColor="#607080"/>
                    <stop offset="100%" stopColor="#2a3848"/>
                  </radialGradient>
                  <radialGradient id="hsh" cx="75%" cy="78%" r="52%">
                    <stop offset="0%" stopColor="#000" stopOpacity="0.45"/>
                    <stop offset="100%" stopColor="#000" stopOpacity="0"/>
                  </radialGradient>
                  <clipPath id="hb"><circle cx="114" cy="130" r="106"/></clipPath>
                </defs>
                <circle cx="114" cy="130" r="109" fill="none" stroke="#22c55e" strokeWidth="1.5" strokeDasharray="5,4" opacity="0.5"/>
                <circle cx="114" cy="130" r="106" fill="url(#hs)"/>
                <g clipPath="url(#hb)">
                  <polygon points="114,108 135,122 128,148 100,148 93,122" fill="#111"/>
                  <polygon points="114,24 156,44 150,72 114,82 78,72 72,44" fill="#111"/>
                  <polygon points="158,48 210,72 218,114 196,140 168,132 156,86" fill="#111"/>
                  <polygon points="196,156 218,196 204,238 168,246 140,220 148,178" fill="#111"/>
                  <polygon points="88,178 80,220 42,246 10,218 26,180 60,168" fill="#111"/>
                  <polygon points="72,44 56,86 28,132 10,114 18,72 70,48" fill="#111"/>
                </g>
                <g clipPath="url(#hb)" stroke="#222" strokeWidth="2.2" fill="none">
                  <polygon points="114,108 135,122 128,148 100,148 93,122"/>
                  <line x1="114" y1="108" x2="150" y2="72"/><line x1="114" y1="108" x2="78" y2="72"/>
                  <line x1="135" y1="122" x2="168" y2="132"/><line x1="135" y1="122" x2="156" y2="86"/>
                  <line x1="128" y1="148" x2="148" y2="178"/><line x1="100" y1="148" x2="80" y2="178"/>
                  <line x1="93" y1="122" x2="56" y2="86"/><line x1="150" y1="72" x2="156" y2="86"/>
                  <line x1="78" y1="72" x2="56" y2="86"/>
                </g>
                <g clipPath="url(#hb)" stroke="#22c55e" strokeWidth="1.2" fill="none" opacity="0.5">
                  <ellipse cx="114" cy="130" rx="106" ry="22"/>
                  <ellipse cx="114" cy="130" rx="22" ry="106"/>
                </g>
                <circle cx="114" cy="130" r="106" fill="url(#hsh)"/>
                <circle cx="114" cy="24" r="5" fill="#4ade80" opacity="0.9"/>
                <ellipse cx="80" cy="82" rx="28" ry="18" fill="white" opacity="0.28"/>
              </svg>
            </div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: "-.01em" }}>Bet<span style={{ color: C.accent }}>Score</span> <span style={{ color: C.green, fontSize:18 }}>IA</span></div>
                <div style={{ fontSize: 10, color: C.dim, letterSpacing: ".08em" }}>SPORTS BETTING INTELLIGENCE · IA</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["analizar", "⚡ Analizar"], ["historial", "📋 Historial"]].map(([k, l]) => (
                <button key={k} onClick={() => setMainTab(k)} style={{
                  background: mainTab === k ? "linear-gradient(135deg,#16a34a,#22c55e)" : "transparent",
                  color: mainTab === k ? "#fff" : C.muted,
                  border: `1px solid ${mainTab === k ? "#22c55e" : C.border}`,
                  boxShadow: mainTab === k ? "0 2px 12px rgba(34,197,94,0.3)" : "none",
                  borderRadius: 8, padding: "7px 16px", fontWeight: 700, fontSize: 13, cursor: "pointer"
                }}>{l}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 920, margin: "0 auto", padding: "24px 16px" }}>

        {mainTab === "historial" && <Historial />}

        {mainTab === "analizar" && (
          <>
            {/* FORM */}
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "24px", marginBottom: 24 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 18, color: C.accent }}>🔍 Partido a analizar</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 600 }}>Equipo Local *</div>
                  <input style={inputS} value={form.local} onChange={e => setForm(f => ({ ...f, local: e.target.value }))} placeholder="Ej: Real Madrid" />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 600 }}>Equipo Visitante *</div>
                  <input style={inputS} value={form.visitante} onChange={e => setForm(f => ({ ...f, visitante: e.target.value }))} placeholder="Ej: Atlético Madrid" />
                </div>
              </div>

              <button onClick={analyze} disabled={loading || !form.local || !form.visitante} style={{
                width: "100%", background: loading ? C.dim : "linear-gradient(135deg,#16a34a,#22c55e)", color: "#fff", border: "none", borderRadius: 10,
                padding: "14px", fontWeight: 800, fontSize: 15, cursor: loading ? "not-allowed" : "pointer",
                boxShadow: loading ? "none" : "0 4px 20px rgba(34,197,94,0.45)", letterSpacing: ".03em"
              }}>
                {loading ? "Analizando..." : "⚡ ANALIZAR 8+ MERCADOS CON IA"}
              </button>
              {loading && progress && (
                <div style={{ marginTop: 12, textAlign: "center", fontSize: 13, color: C.muted }}>
                  <div style={{ width: "100%", height: 3, background: C.border, borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
                    <div style={{ height: "100%", background: C.accent, animation: "progress 18s linear forwards", width: "0%" }} />
                  </div>
                  <style>{`@keyframes progress { to { width: 95%; } }`}</style>
                  {progress}
                </div>
              )}
              {error && <div style={{ marginTop: 12, color: C.red, fontSize: 13, background: C.redDim, borderRadius: 8, padding: "10px 14px" }}>{error}</div>}
            </div>

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

                  {/* ── STAKE SUGERIDO ── */}
                  {(() => {
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
                            value={bank}
                            onChange={e => setBank(parseFloat(e.target.value) || 0)}
                            style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 10px", color: C.text, fontSize: 13, fontWeight: 600 }}
                          />
                          <span style={{ fontSize: 11, color: sk.color, fontWeight: 700, flexShrink: 0 }}>EV +{((data.top_apuesta?.ev||0)*100).toFixed(0)}% · {data.top_apuesta?.nivel_confianza}% conf</span>
                        </div>
                        <div style={{ marginTop: 10, fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                          📊 Stake calculado con el modelo de gestión de riesgo de BetScore IA basado en EV y nivel de confianza
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
                  {[["mercados", "📌 Mercados"], ["factores", "⚖️ Factores"], ["bajas", "🏥 Bajas"], ["graficas", "📊 Gráficas"], ["post", "📱 Post"]].map(([k, l]) => (
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
                      {top3.map(m => <MercadoCard key={m.nombre} m={m} partido={data.partido} rank={m.ranking} bank={bank} />)}
                    </div>
                    {otros.length > 0 && (
                      <>
                        <div style={{ fontWeight: 600, fontSize: 13, color: C.dim, marginBottom: 12 }}>📋 Otros mercados analizados (sin suficiente EV)</div>
                        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                          {otros.map((m, i) => (
                            <div key={m.nombre} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: i < otros.length - 1 ? `1px solid ${C.border}` : "none" }}>
                              <div>
                                <div style={{ fontSize: 13, color: C.text }}>{MERCADOS_ICONS[m.nombre] || "📌"} {m.nombre}</div>
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
                {tab === "post" && (
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

                <div style={{ marginTop: 20, textAlign: "center" }}>
                  <button onClick={() => { setData(null); setForm({ local: "", visitante: "" }); }} style={{
                    background: "transparent", border: `1px solid ${C.border}`, color: C.muted,
                    borderRadius: 8, padding: "9px 20px", cursor: "pointer", fontSize: 13
                  }}>🔄 Nuevo análisis</button>
                </div>
              </>
            )}
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
