import { useState, useEffect, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis, Legend,
  LineChart, Line
} from "recharts";

const C = {
  bg: "#07090f",
  card: "#0e1320",
  card2: "#141b2d",
  card3: "#1a2238",
  border: "#1e2d45",
  accent: "#f59e0b",
  green: "#10b981",
  greenDim: "#052e16",
  red: "#ef4444",
  redDim: "#450a0a",
  blue: "#3b82f6",
  purple: "#a78bfa",
  text: "#f1f5f9",
  muted: "#94a3b8",
  dim: "#475569",
};

const MERCADOS_ICONS = {
  "1X2": "🏆", "Doble Oportunidad": "🔄", "Ambos Marcan (BTTS)": "⚽",
  "Más de 2.5 Goles": "📈", "Menos de 2.5 Goles": "📉",
  "Más de 1.5 Goles": "🎯", "Hándicap Asiático": "⚖️",
  "Córners +9.5": "📐", "Tarjetas +3.5": "🟨",
  "Gana en el Descanso": "🕐", "Primer Gol Antes Min 30": "⚡",
  "HT/FT": "📊"
};

const SYSTEM_PROMPT = `Eres un analista cuantitativo de apuestas deportivas de nivel élite. Analizas múltiples mercados de apuesta para encontrar el mayor valor esperado (EV positivo).

⚠️ INSTRUCCIÓN CRÍTICA DE FORMATO — MÁXIMA PRIORIDAD:
Tu respuesta DEBE comenzar EXACTAMENTE con el carácter "{" y terminar EXACTAMENTE con "}".
NO escribas ningún texto antes del JSON. NO escribas ningún texto después del JSON.
NO uses markdown, NO uses bloques de código, NO uses comillas adicionales.
RESPUESTA INVÁLIDA: "Con toda la información... {json}"
RESPUESTA VÁLIDA: {"partido": {...}, ...}
Si escribes algo antes del "{" o después del "}", la aplicación fallará completamente.

══════════════════════════════════════════════
REGLAS ABSOLUTAS — NO NEGOCIABLES
══════════════════════════════════════════════

1. BÚSQUEDA WEB OBLIGATORIA — Antes de responder debes buscar:
   a) Cuotas reales: "[equipo local] vs [equipo visitante] odds bet365 2025"
   b) Lesionados local: "[equipo local] injuries squad news 2025"
   c) Lesionados visitante: "[equipo visitante] injuries squad news 2025"
   d) Estadísticas del partido: "[partido] stats xG corners cards average 2025"

2. CUOTAS REALES — Rangos obligatorios por mercado:
   - 1X2 favorito claro: 1.20–1.65
   - BTTS Sí: 1.55–2.10
   - Over 2.5 goles: 1.55–2.20
   - Under 2.5 goles: 1.65–2.30
   - Doble Oportunidad: 1.15–1.50
   - Hándicap Asiático -1: 1.70–2.30
   - NUNCA cuotas inventadas superiores a 2.80 para mercados de alta probabilidad

3. JUGADORES — SIEMPRE con nombre, posición y si es titular:
   Formato: "Nombre Apellido (POSICIÓN, titular habitual): Estado — Detalle"
   Posiciones: GK / DC / LAT / MCD / MC / EXT / DEL
   Si no hay bajas confirmadas: "Sin bajas confirmadas públicamente (verificado)"

4. ANÁLISIS DE VALOR (EV):
   Para cada mercado calcular:
   - Probabilidad real estimada (%)
   - Probabilidad implícita de la cuota (1/cuota × 100)
   - EV = (prob_real × cuota) - 1
   - Solo recomendar mercados con EV > 0.05 (5% de valor positivo)

5. TOP 3 MERCADOS:
   Analiza mínimo 8 mercados distintos y selecciona los 3 con mayor EV positivo.
   El mercado principal debe tener cuota mínima 1.40.

══════════════════════════════════════════════
RESPONDE ÚNICAMENTE CON ESTE JSON EXACTO
══════════════════════════════════════════════

{
  "partido": {
    "local": "string",
    "visitante": "string",
    "competicion": "string",
    "fecha": "string",
    "estadio": "string"
  },
  "mercados_analizados": [
    {
      "nombre": "nombre del mercado",
      "descripcion": "descripción específica de la apuesta",
      "cuota": 1.75,
      "cuota_fuente": "Bet365 / Betfair / Estimada",
      "prob_real": 65,
      "prob_implicita": 57,
      "ev": 0.14,
      "nivel_confianza": 72,
      "recomendado": true,
      "ranking": 1,
      "razon": "Explicación en 2 oraciones de por qué este mercado tiene valor"
    }
  ],
  "top_apuesta": {
    "mercado": "nombre del mercado ganador",
    "descripcion": "descripción exacta de la apuesta",
    "cuota": 1.75,
    "cuota_fuente": "Bet365",
    "prob_real": 65,
    "prob_implicita": 57,
    "ev": 0.14,
    "nivel_confianza": 72,
    "nivel_riesgo": "BAJO",
    "razon_ejecutiva": "Explicación ejecutiva en 3-4 oraciones del por qué esta es la mejor apuesta del partido"
  },
  "probabilidades_1x2": {
    "victoria_local": 55,
    "empate": 25,
    "victoria_visitante": 20
  },
  "forma_reciente": {
    "local": {
      "resultados": ["V 2-1 vs Arsenal", "E 1-1 vs Chelsea", "V 3-0 vs Everton", "D 0-2 vs City", "V 1-0 vs Brentford"],
      "goles_favor": 14,
      "goles_contra": 6,
      "partidos": 5,
      "puntos": 10,
      "promedio_goles_favor": 2.1,
      "promedio_goles_contra": 0.9,
      "xG_promedio": 1.85,
      "corners_promedio": 5.8,
      "tarjetas_promedio": 1.6
    },
    "visitante": {
      "resultados": ["V 1-0 vs Wolves", "D 1-3 vs Liverpool", "E 2-2 vs Newcastle", "V 2-0 vs Fulham", "D 0-1 vs Tottenham"],
      "goles_favor": 8,
      "goles_contra": 7,
      "partidos": 5,
      "puntos": 7,
      "promedio_goles_favor": 1.4,
      "promedio_goles_contra": 1.2,
      "xG_promedio": 1.35,
      "corners_promedio": 4.9,
      "tarjetas_promedio": 2.1
    }
  },
  "bajas": {
    "local": [
      {
        "nombre": "Nombre Completo",
        "posicion": "DC",
        "titular_habitual": true,
        "estado": "Lesionado",
        "impacto": "Alto",
        "detalle": "Rotura de ligamentos, baja estimada 3 meses"
      }
    ],
    "visitante": [],
    "estado_plantilla_local": "Con bajas confirmadas (ver lista)",
    "estado_plantilla_visitante": "Sin bajas confirmadas públicamente (verificado)"
  },
  "factores": [
    {
      "nombre": "Forma reciente",
      "local": 8.5,
      "visitante": 6.0,
      "ganador": "local",
      "detalle": "Local 10pts/15 posibles. Visitante 7pts/15. Local superior en eficacia ofensiva (2.1 goles/partido).",
      "icono": "📊"
    },
    {
      "nombre": "Bajas y plantilla",
      "local": 7.0,
      "visitante": 8.0,
      "ganador": "visitante",
      "detalle": "Local: [Jugador] (DC, titular) fuera. Visitante: Plantilla completa verificada.",
      "icono": "🏥"
    },
    {
      "nombre": "Ventaja local",
      "local": 7.5,
      "visitante": 5.0,
      "ganador": "local",
      "detalle": "Local: 8 partidos sin perder en casa. Promedio 1.9 goles a favor en casa.",
      "icono": "🏟️"
    },
    {
      "nombre": "H2H histórico",
      "local": 6.5,
      "visitante": 6.0,
      "ganador": "local",
      "detalle": "Últimos 5 H2H: 3V-1E-1D para local. Último enfrentamiento: Local 2-1.",
      "icono": "⚔️"
    },
    {
      "nombre": "Motivación",
      "local": 8.0,
      "visitante": 6.5,
      "ganador": "local",
      "detalle": "Local necesita puntos para mantener top-4. Visitante en zona tranquila.",
      "icono": "🎯"
    },
    {
      "nombre": "Árbitro",
      "local": 6.5,
      "visitante": 6.5,
      "ganador": "empate",
      "detalle": "Árbitro: [Nombre si conocido]. Promedio 3.8 tarjetas/partido. Sin tendencia especial con ninguno.",
      "icono": "🟨"
    },
    {
      "nombre": "Cansancio",
      "local": 7.0,
      "visitante": 7.5,
      "ganador": "visitante",
      "detalle": "Local jugó entre semana (72h). Visitante con 5 días de descanso.",
      "icono": "⚡"
    },
    {
      "nombre": "EV mercado principal",
      "local": 7.5,
      "visitante": 5.5,
      "ganador": "local",
      "detalle": "Cuota [X] con EV positivo del [Y]%. Probabilidad real supera implícita en [Z]pp.",
      "icono": "💰"
    }
  ],
  "puntos_clave": [
    "⚠️ BAJA: [Nombre jugador] ([posición], titular) — [razón]. Reemplazado por [nombre] con menor nivel.",
    "📈 ESTADÍSTICA: [Equipo] promedia [X] goles/partido en casa esta temporada.",
    "🎯 EV POSITIVO: Cuota [X] tiene valor de +[Y]% sobre probabilidad real calculada.",
    "⚽ MERCADO CLAVE: [Razón específica por la que el mercado elegido tiene ventaja].",
    "📊 H2H: Los últimos [N] enfrentamientos terminaron con [patrón específico de goles/resultado]."
  ],
  "estadisticas_clave": {
    "promedio_goles_partido": 2.8,
    "partidos_over25_local": 62,
    "partidos_over25_visitante": 55,
    "btts_porcentaje_local": 58,
    "btts_porcentaje_visitante": 52,
    "corners_promedio_partido": 10.7,
    "tarjetas_promedio_partido": 3.7
  },
  "post_telegram": "🏆 *BETIQ PRO* — ANÁLISIS ÉLITE\\n\\n⚽ [Local] vs [Visitante]\\n🏆 [Competición] | [Fecha]\\n\\n━━━━━━━━━━━━━━━━━━━━\\n🥇 APUESTA #1 — MAYOR VALOR\\n━━━━━━━━━━━━━━━━━━━━\\n🎯 [Mercado]: [Descripción]\\n💰 Cuota: [X.XX] ([Fuente])\\n📊 Confianza: [X]% | EV: +[Y]%\\n\\n🥈 ALTERNATIVA #2\\n🎯 [Mercado 2]: [Descripción]\\n💰 Cuota: [X.XX] | Confianza: [X]%\\n\\n🥉 ALTERNATIVA #3\\n🎯 [Mercado 3]: [Descripción]\\n💰 Cuota: [X.XX] | Confianza: [X]%\\n\\n━━━━━━━━━━━━━━━━━━━━\\n🔑 PUNTOS CLAVE\\n━━━━━━━━━━━━━━━━━━━━\\n• [Punto con jugador específico]\\n• [Estadística específica]\\n• [Contexto relevante]\\n\\n🏥 Bajas: [Jugador] ([pos.]) — [estado]\\n\\n⚡ Local [X]% | Empate [X]% | Visit. [X]%\\n⚠️ Solo sugerencia. Juega responsable.",
  "post_whatsapp": "🏆 *BETIQ PRO*\\n\\n⚽ *[Local] vs [Visitante]*\\n📅 [Fecha] | 🏆 [Competición]\\n\\n─────────────────────\\n🥇 *MEJOR APUESTA*\\n─────────────────────\\n🎯 *[Mercado]*\\n📝 [Descripción]\\n💰 Cuota: *[X.XX]* ([Fuente])\\n✅ Confianza: *[X]%* | EV: *+[Y]%*\\n\\n─────────────────────\\n🥈 *ALTERNATIVA*\\n─────────────────────\\n🎯 [Mercado 2] — Cuota *[X.XX]*\\n🎯 [Mercado 3] — Cuota *[X.XX]*\\n\\n─────────────────────\\n🔑 *PUNTOS CLAVE*\\n─────────────────────\\n1️⃣ [Jugador específico + situación]\\n2️⃣ [Estadística específica]\\n3️⃣ [Contexto de valor]\\n\\n🏥 *Bajas:* [Jugador] ([pos.]) — [estado]\\n\\n📊 Local [X]% | Empate [X]% | Visit. [X]%\\n_⚠️ Solo sugerencia. Juega responsable._"
}`;

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

function MercadoCard({ m, partido, rank }) {
  const rankColors = { 1: C.accent, 2: C.muted, 3: C.dim };
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

// ─── HISTORIAL ───────────────────────────────────────────────────────────────
function Historial() {
  const [records, setRecords] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ partido: "", mercado: "", cuota: "", resultado: "PENDIENTE", fecha: "" });

  useEffect(() => {
    const load = async () => {
      try {
        const r = await window.storage.get("betiq_historial");
        if (r?.value) setRecords(JSON.parse(r.value));
      } catch { setRecords([]); }
      setLoaded(true);
    };
    load();
  }, []);

  const save = async (newRecs) => {
    try { await window.storage.set("betiq_historial", JSON.stringify(newRecs)); } catch { }
    setRecords(newRecs);
  };

  const addRecord = async () => {
    if (!form.partido || !form.cuota) return;
    const newRec = { ...form, id: Date.now(), cuota: parseFloat(form.cuota), fecha: form.fecha || new Date().toLocaleDateString("es-CO") };
    const updated = [newRec, ...records];
    await save(updated);
    setForm({ partido: "", mercado: "", cuota: "", resultado: "PENDIENTE", fecha: "" });
    setShowAdd(false);
  };

  const updateResult = async (id, resultado) => {
    const updated = records.map(r => r.id === id ? { ...r, resultado } : r);
    await save(updated);
  };

  const deleteRecord = async (id) => {
    const updated = records.filter(r => r.id !== id);
    await save(updated);
  };

  const won = records.filter(r => r.resultado === "GANADA");
  const lost = records.filter(r => r.resultado === "PERDIDA");
  const pending = records.filter(r => r.resultado === "PENDIENTE");
  const closed = records.filter(r => r.resultado !== "PENDIENTE");
  const winRate = closed.length > 0 ? ((won.length / closed.length) * 100).toFixed(1) : 0;
  const roi = closed.length > 0
    ? (((won.reduce((s, r) => s + r.cuota - 1, 0) - lost.length) / closed.length) * 100).toFixed(1)
    : 0;

  // Racha actual
  let racha = 0, rachaType = "";
  for (let i = 0; i < records.length; i++) {
    if (records[i].resultado === "PENDIENTE") continue;
    if (i === 0 || records[i].resultado === rachaType) { rachaType = records[i].resultado; racha++; }
    else break;
  }

  // Para gráfica de tendencia (últimas 10 cerradas)
  const tendencia = closed.slice(0, 10).reverse().map((r, i) => ({
    n: i + 1,
    roi: parseFloat(r.resultado === "GANADA" ? (r.cuota - 1) : -1)
  }));
  let cumROI = 0;
  const tendenciaAcum = tendencia.map(t => { cumROI += t.roi; return { n: t.n, roi: parseFloat(cumROI.toFixed(2)) }; });

  const inputS = { background: C.card2, border: `1px solid ${C.border}`, borderRadius: 7, padding: "8px 12px", color: C.text, fontSize: 13, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" };

  if (!loaded) return <div style={{ textAlign: "center", color: C.muted, padding: 40 }}>Cargando historial...</div>;

  return (
    <div>
      {/* STATS OVERVIEW */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
        {[
          { l: "Apuestas totales", v: records.length, c: C.blue },
          { l: "% de acierto", v: `${winRate}%`, c: parseFloat(winRate) >= 55 ? C.green : parseFloat(winRate) >= 45 ? C.accent : C.red },
          { l: "ROI acumulado", v: `${roi > 0 ? "+" : ""}${roi}%`, c: parseFloat(roi) > 0 ? C.green : C.red },
          { l: "Racha actual", v: racha > 0 ? `${racha}${rachaType === "GANADA" ? "✅" : "❌"}` : "—", c: rachaType === "GANADA" ? C.green : C.red },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px", textAlign: "center" }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: c }}>{v}</div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{l}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 20 }}>
        {[
          { l: "Ganadas", v: won.length, c: C.green },
          { l: "Perdidas", v: lost.length, c: C.red },
          { l: "Pendientes", v: pending.length, c: C.accent },
        ].map(({ l, v, c }) => (
          <div key={l} style={{ background: C.card2, borderRadius: 8, padding: "10px", textAlign: "center", border: `1px solid ${c}33` }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: c }}>{v}</div>
            <div style={{ fontSize: 11, color: C.dim }}>{l}</div>
          </div>
        ))}
      </div>

      {/* TENDENCIA */}
      {tendenciaAcum.length > 1 && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12, color: C.muted }}>📈 Tendencia ROI acumulado (últimas {tendenciaAcum.length} cerradas)</div>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={tendenciaAcum} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="n" tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} />
              <YAxis tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} />
              <Tooltip contentStyle={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text }} formatter={(v) => [`${v > 0 ? "+" : ""}${v} u.`, "ROI acum."]} />
              <Line type="monotone" dataKey="roi" stroke={parseFloat(roi) >= 0 ? C.green : C.red} strokeWidth={2} dot={{ r: 3, fill: C.accent }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* BOTÓN AGREGAR */}
      <button onClick={() => setShowAdd(!showAdd)} style={{
        width: "100%", background: C.accent, color: "#000", border: "none", borderRadius: 8,
        padding: "12px", fontWeight: 800, fontSize: 14, cursor: "pointer", marginBottom: 16
      }}>
        {showAdd ? "✕ Cancelar" : "+ Registrar nueva apuesta"}
      </button>

      {showAdd && (
        <div style={{ background: C.card, border: `1px solid ${C.accent}44`, borderRadius: 12, padding: "18px", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: C.accent, marginBottom: 14 }}>📝 Nueva apuesta</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 5 }}>Partido *</div>
              <input style={inputS} value={form.partido} onChange={e => setForm(f => ({ ...f, partido: e.target.value }))} placeholder="Local vs Visitante" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 5 }}>Mercado</div>
              <input style={inputS} value={form.mercado} onChange={e => setForm(f => ({ ...f, mercado: e.target.value }))} placeholder="Ej: Over 2.5 Goles" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 5 }}>Cuota *</div>
              <input style={inputS} type="number" step="0.01" value={form.cuota} onChange={e => setForm(f => ({ ...f, cuota: e.target.value }))} placeholder="1.75" />
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 5 }}>Fecha</div>
              <input style={inputS} value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} placeholder="DD/MM/YYYY" />
            </div>
          </div>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Resultado inicial</div>
            <div style={{ display: "flex", gap: 8 }}>
              {["PENDIENTE", "GANADA", "PERDIDA"].map(r => (
                <button key={r} onClick={() => setForm(f => ({ ...f, resultado: r }))} style={{
                  flex: 1, padding: "8px", borderRadius: 7, border: `1px solid ${form.resultado === r ? (r === "GANADA" ? C.green : r === "PERDIDA" ? C.red : C.accent) : C.border}`,
                  background: form.resultado === r ? (r === "GANADA" ? C.greenDim : r === "PERDIDA" ? C.redDim : C.accent + "22") : "transparent",
                  color: r === "GANADA" ? C.green : r === "PERDIDA" ? C.red : C.accent, fontSize: 12, fontWeight: 700, cursor: "pointer"
                }}>{r === "GANADA" ? "✅ GANADA" : r === "PERDIDA" ? "❌ PERDIDA" : "⏳ PENDIENTE"}</button>
              ))}
            </div>
          </div>
          <button onClick={addRecord} disabled={!form.partido || !form.cuota} style={{
            width: "100%", background: C.green, color: "#000", border: "none", borderRadius: 8,
            padding: "11px", fontWeight: 800, fontSize: 13, cursor: "pointer"
          }}>Guardar apuesta</button>
        </div>
      )}

      {/* LISTA */}
      {records.length === 0
        ? <div style={{ textAlign: "center", color: C.dim, padding: "40px 20px", background: C.card, borderRadius: 12, border: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📋</div>
          <div style={{ fontSize: 14, color: C.muted }}>Sin apuestas registradas aún</div>
          <div style={{ fontSize: 12, color: C.dim, marginTop: 6 }}>Genera un análisis y registra tu primera apuesta</div>
        </div>
        : records.map(r => {
          const resColor = r.resultado === "GANADA" ? C.green : r.resultado === "PERDIDA" ? C.red : C.accent;
          const resIcon = r.resultado === "GANADA" ? "✅" : r.resultado === "PERDIDA" ? "❌" : "⏳";
          return (
            <div key={r.id} style={{ background: C.card, border: `1px solid ${resColor}33`, borderRadius: 10, padding: "14px 16px", marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 20 }}>{resIcon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.partido}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{r.mercado || "Sin mercado"} · Cuota <span style={{ color: C.accent, fontWeight: 700 }}>x{r.cuota?.toFixed(2)}</span> · {r.fecha}</div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {r.resultado === "PENDIENTE" && (
                  <>
                    <button onClick={() => updateResult(r.id, "GANADA")} style={{ background: C.greenDim, border: `1px solid ${C.green}`, color: C.green, borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✅ Ganó</button>
                    <button onClick={() => updateResult(r.id, "PERDIDA")} style={{ background: C.redDim, border: `1px solid ${C.red}`, color: C.red, borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>❌ Perdió</button>
                  </>
                )}
                <button onClick={() => deleteRecord(r.id)} style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.dim, borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer" }}>🗑</button>
              </div>
            </div>
          );
        })
      }
    </div>
  );
}

// ─── APP PRINCIPAL ────────────────────────────────────────────────────────────
export default function BetIQProV3() {
  const [form, setForm] = useState({ local: "", visitante: "", liga: "", fecha: "", contexto: "" });
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
      "🏆 Seleccionando los 3 mejores mercados...",
    ];
    let si = 0;
    setProgress(steps[0]);
    const iv = setInterval(() => { si = Math.min(si + 1, steps.length - 1); setProgress(steps[si]); }, 3500);

    const apiCall = async (system, messages, withSearch = false, maxTok = 4000) => {
      const body = {
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTok,
        system,
        messages,
      };
      if (withSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || "API error");
      return (json.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    };

    try {
      // PASO 1 — búsqueda web libre (texto natural, sin restricción de formato)
      setProgress("🔍 Buscando cuotas reales en Bet365/Betfair...");
      const searchData = await apiCall(
        "Eres un investigador deportivo experto. Usa búsqueda web para obtener datos reales y actuales. Responde con un resumen detallado en texto libre.",
        [{
          role: "user",
          content: `Busca información real y actual para el partido "${form.local} vs ${form.visitante}" (${form.liga || "fútbol"}, ${form.fecha || "próximos días"}):
1. Cuotas actuales en Bet365 o Betfair — busca: "${form.local} vs ${form.visitante} odds bet365 2026"
2. Lesionados ${form.local} — busca: "${form.local} lesionados bajas mayo 2026"
3. Lesionados ${form.visitante} — busca: "${form.visitante} lesionados bajas mayo 2026"
4. Últimos 5 resultados de cada equipo
5. Estadísticas: promedio goles, córners y tarjetas por partido esta temporada
Incluye nombres exactos de jugadores lesionados/suspendidos con sus posiciones.`
        }],
        true,
        3000
      );

      // PASO 2 — JSON con delimitadores explícitos — max_tokens alto para no truncar
      setProgress("⚖️ Calculando EV en 8+ mercados...");
      const jsonRaw = await apiCall(
        SYSTEM_PROMPT,
        [{
          role: "user",
          content: `Partido: ${form.local} vs ${form.visitante} | Liga: ${form.liga || "N/D"} | Fecha: ${form.fecha || "Próximos días"} | Contexto: ${form.contexto || "Ninguno"}

DATOS REALES ENCONTRADOS EN LA BÚSQUEDA:
${searchData}

INSTRUCCIÓN DE FORMATO — CRÍTICA:
Escribe EXACTAMENTE esto y nada más:
---JSON_START---
{ aquí va el JSON completo }
---JSON_END---

No escribas NADA antes de ---JSON_START--- ni después de ---JSON_END---.
IMPORTANTE: Omite los campos "post_telegram" y "post_whatsapp" del JSON — se generan automáticamente.
Analiza exactamente 8 mercados: 1X2, Doble Oportunidad, BTTS, Más de 2.5 Goles, Menos de 2.5 Goles, Más de 1.5 Goles, Hándicap Asiático, y Córners o Tarjetas. Usa las cuotas reales de la búsqueda. Cuota mínima mercado #1: 1.40.`
        }],
        false,
        8000  // suficiente para JSON completo sin truncar
      );

      clearInterval(iv);

      // Extracción por delimitadores — no falla aunque haya texto alrededor
      let raw = jsonRaw;
      const startMarker = "---JSON_START---";
      const endMarker = "---JSON_END---";
      const startIdx = raw.indexOf(startMarker);
      const endIdx = raw.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        raw = raw.slice(startIdx + startMarker.length, endIdx).trim();
      } else {
        // Fallback: buscar primer { y último }
        raw = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
        const fb = raw.indexOf("{");
        const lb = raw.lastIndexOf("}");
        if (fb === -1 || lb === -1) throw new Error("No se encontró JSON en la respuesta del modelo");
        raw = raw.slice(fb, lb + 1);
      }

      const parsed = JSON.parse(raw);

      // Generar posts en el cliente (evitamos que el modelo los genere para ahorrar tokens)
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

      parsed.post_telegram = `🏆 *BETIQ PRO* — ANÁLISIS ÉLITE\n\n⚽ ${parsed.partido?.local} vs ${parsed.partido?.visitante}\n🏆 ${parsed.partido?.competicion || form.liga || "Fútbol"} | ${parsed.partido?.fecha || form.fecha}\n\n━━━━━━━━━━━━━━━━━━━━\n🥇 APUESTA #1 — MAYOR VALOR\n━━━━━━━━━━━━━━━━━━━━\n🎯 ${nombre1}: ${desc1}\n💰 Cuota: ${cuota1} (${fuente1})\n📊 Confianza: ${conf1}% | EV: +${ev1}%\n\n🥈 ALTERNATIVA #2\n🎯 ${t2.nombre || "—"}: ${t2.descripcion || "—"}\n💰 Cuota: ${(t2.cuota || 0).toFixed(2)} | Confianza: ${t2.nivel_confianza || "—"}%\n\n🥉 ALTERNATIVA #3\n🎯 ${t3.nombre || "—"}: ${t3.descripcion || "—"}\n💰 Cuota: ${(t3.cuota || 0).toFixed(2)} | Confianza: ${t3.nivel_confianza || "—"}%\n\n━━━━━━━━━━━━━━━━━━━━\n🔑 PUNTOS CLAVE\n━━━━━━━━━━━━━━━━━━━━\n${(parsed.puntos_clave || []).map(p => `• ${p}`).join("\n")}\n\n🏥 Bajas ${parsed.partido?.local}: ${bL}\n🏥 Bajas ${parsed.partido?.visitante}: ${bV}\n\n⚡ Local ${pr.victoria_local}% | Empate ${pr.empate}% | Visit. ${pr.victoria_visitante}%\n\n⚠️ Solo sugerencia. Juega con responsabilidad.`;

      parsed.post_whatsapp = `🏆 *BETIQ PRO*\n\n⚽ *${parsed.partido?.local} vs ${parsed.partido?.visitante}*\n📅 ${parsed.partido?.fecha || form.fecha} | 🏆 ${parsed.partido?.competicion || form.liga || "Fútbol"}\n\n─────────────────────\n🥇 *MEJOR APUESTA*\n─────────────────────\n🎯 *${nombre1}*\n📝 ${desc1}\n💰 Cuota: *${cuota1}* (${fuente1})\n✅ Confianza: *${conf1}%* | EV: *+${ev1}%*\n\n─────────────────────\n🥈 *ALTERNATIVAS*\n─────────────────────\n🎯 ${t2.nombre || "—"} — Cuota *${(t2.cuota || 0).toFixed(2)}*\n🎯 ${t3.nombre || "—"} — Cuota *${(t3.cuota || 0).toFixed(2)}*\n\n─────────────────────\n🔑 *PUNTOS CLAVE*\n─────────────────────\n${(parsed.puntos_clave || []).map((p, i) => `${i + 1}️⃣ ${p}`).join("\n")}\n\n🏥 *Bajas:*\n▪️ ${parsed.partido?.local}: ${bL}\n▪️ ${parsed.partido?.visitante}: ${bV}\n\n📊 Local ${pr.victoria_local}% | Empate ${pr.empate}% | Visit. ${pr.victoria_visitante}%\n\n_⚠️ Solo sugerencia. Juega responsable._`;

      setData(parsed);
      setTab("mercados");
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

  const top3 = data?.mercados_analizados?.filter(m => m.recomendado).sort((a, b) => a.ranking - b.ranking) || [];
  const otros = data?.mercados_analizados?.filter(m => !m.recomendado) || [];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter','Segoe UI',sans-serif", paddingBottom: 60 }}>

      {/* HEADER */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "18px 24px 14px" }}>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 38, height: 38, background: C.accent, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⚽</div>
              <div>
                <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: "-.01em" }}>BETIQ <span style={{ color: C.accent }}>PRO</span> <span style={{ fontSize: 12, color: C.dim, fontWeight: 400 }}>v3</span></div>
                <div style={{ fontSize: 10, color: C.dim, letterSpacing: ".08em" }}>MULTI-MERCADO · CUOTAS REALES · HISTORIAL</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["analizar", "⚡ Analizar"], ["historial", "📋 Historial"]].map(([k, l]) => (
                <button key={k} onClick={() => setMainTab(k)} style={{
                  background: mainTab === k ? C.accent : "transparent",
                  color: mainTab === k ? "#000" : C.muted,
                  border: `1px solid ${mainTab === k ? C.accent : C.border}`,
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
                <div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 600 }}>Liga / Competición</div>
                  <input style={inputS} value={form.liga} onChange={e => setForm(f => ({ ...f, liga: e.target.value }))} placeholder="Ej: La Liga, Champions League" />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 600 }}>Fecha</div>
                  <input style={inputS} value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} placeholder="Ej: 18/05/2025" />
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, fontWeight: 600 }}>Contexto adicional</div>
                <textarea style={{ ...inputS, height: 65, resize: "vertical", lineHeight: 1.5 }} value={form.contexto} onChange={e => setForm(f => ({ ...f, contexto: e.target.value }))} placeholder="Ej: Partido de vuelta, local necesita ganar, sin estadio propio, etc." />
              </div>
              <button onClick={analyze} disabled={loading || !form.local || !form.visitante} style={{
                width: "100%", background: loading ? C.dim : C.accent, color: "#000", border: "none", borderRadius: 10,
                padding: "13px", fontWeight: 800, fontSize: 15, cursor: loading ? "not-allowed" : "pointer"
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
                <div style={{ background: `linear-gradient(135deg, #0a1628, #071a12)`, border: `2px solid ${C.green}44`, borderRadius: 14, padding: "22px", marginBottom: 20 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    <Badge color={C.green}>🏆 MEJOR APUESTA</Badge>
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
                      color: tab === k ? "#000" : C.muted,
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
                      {top3.map(m => <MercadoCard key={m.nombre} m={m} partido={data.partido} rank={m.ranking} />)}
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
                          flex: 1, background: postMode === k ? (k === "telegram" ? "#2196F3" : "#25D366") : "transparent",
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
                  <button onClick={() => { setData(null); setForm({ local: "", visitante: "", liga: "", fecha: "", contexto: "" }); }} style={{
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
              {[
                { n: "FREE", p: "$0/día", c: C.green, feats: ["1 análisis/día", "Multi-mercado (8+)", "Historial básico", "Post Telegram/WhatsApp"] },
                { n: "PREMIUM", p: "$4.99/día", c: C.accent, feats: ["Análisis diario premium", "Top 3 mercados con EV", "Historial ilimitado", "ROI tracking", "Post listo para publicar"], hi: true },
                { n: "CANAL MES", p: "$39.99/mes", c: C.blue, feats: ["Todas las apuestas del mes", "Canal Telegram privado", "Alertas en tiempo real", "Soporte personalizado"] },
              ].map(plan => (
                <div key={plan.n} style={{ background: C.card2, border: `1px solid ${plan.hi ? plan.c + "66" : C.border}`, borderRadius: 10, padding: "16px" }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: plan.c, marginBottom: 6 }}>{plan.n}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 12 }}>{plan.p}</div>
                  {plan.feats.map(f => <div key={f} style={{ fontSize: 11, color: C.muted, marginBottom: 5, display: "flex", gap: 6 }}><span style={{ color: C.green }}>✓</span>{f}</div>)}
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
