import { useState, useEffect } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis,
  PolarRadiusAxis, Legend
} from "recharts";

const PIE_COLORS = ["#1D9E75", "#888780", "#378ADD"];
const STORAGE_KEY = "betiq_config_v2";

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; }
}
function saveConfig(cfg) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch {}
}

// ─── API-Football via Worker ──────────────────────────────────────────────────

async function proxyFetch(workerUrl, endpoint, apiKey) {
  const base = workerUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api${endpoint}`, {
    headers: { "x-api-key": apiKey }
  });
  if (!res.ok) throw new Error(`Proxy error ${res.status}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) throw new Error(JSON.stringify(data.errors));
  return data.response || [];
}

async function searchTeam(name, workerUrl, apiKey) {
  const variants = [name];
  const n = name.toLowerCase();
  if (n.includes("santa") || n.includes("santafe")) variants.push("Independiente Santa Fe", "Santa Fe");
  if (n.includes("america") || n.includes("américa")) variants.push("America de Cali", "América de Cali", "America");
  if (n.includes("nacional")) variants.push("Atletico Nacional", "Atlético Nacional");
  if (n.includes("millonarios")) variants.push("Millonarios FC", "Millonarios");
  if (n.includes("junior")) variants.push("Junior FC", "Atletico Junior");
  if (n.includes("boca")) variants.push("Boca Juniors");
  if (n.includes("river")) variants.push("River Plate");
  if (n.includes("flamengo")) variants.push("Flamengo");
  if (n.includes("barcelona") && !n.includes("sc")) variants.push("FC Barcelona");
  for (const v of variants) {
    try {
      const r = await proxyFetch(workerUrl, `/teams?search=${encodeURIComponent(v)}`, apiKey);
      if (r.length > 0) return r[0];
    } catch (_) {}
  }
  return null;
}

async function getLastFixtures(teamId, workerUrl, apiKey) {
  return proxyFetch(workerUrl, `/fixtures?team=${teamId}&last=5`, apiKey);
}
async function getH2H(idA, idB, workerUrl, apiKey) {
  return proxyFetch(workerUrl, `/fixtures/headtohead?h2h=${idA}-${idB}&last=5`, apiKey);
}
async function getInjuries(teamId, workerUrl, apiKey) {
  try { return proxyFetch(workerUrl, `/injuries?team=${teamId}&season=2025`, apiKey); } catch { return []; }
}

function parseForm(fixtures, teamId) {
  return fixtures.slice(0, 5).map(f => {
    const h = f.teams.home.id === teamId;
    const gH = f.goals.home ?? 0, gA = f.goals.away ?? 0;
    if (h) return gH > gA ? "W" : gH < gA ? "L" : "D";
    return gA > gH ? "W" : gA < gH ? "L" : "D";
  }).join("");
}
function formScore(s) {
  return [...(s || "")].reduce((a, c) => a + (c === "W" ? 3 : c === "D" ? 1 : 0), 0);
}

// ─── Claude via Worker ────────────────────────────────────────────────────────

function safeJSON(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try { return JSON.parse(s); } catch (_) {}
  const f = s.indexOf("{"), l = s.lastIndexOf("}");
  if (f !== -1 && l > f) { try { return JSON.parse(s.slice(f, l + 1)); } catch (_) {} }
  return null;
}

async function callClaude(prompt, workerUrl, claudeKey) {
  const base = workerUrl.replace(/\/$/, "");
  const sys = `Eres analista de apuestas deportivas. Responde UNICAMENTE con JSON. Sin texto antes ni despues. Sin markdown. Sin backticks. Empieza con { y termina con }.
Estructura: {"bet":"string","odds":1.65,"confidence":78,"risk":"BAJO","verdict":"string","keyPoints":["a","b","c","d"],"items":[{"factor":"Forma reciente","A":"string","B":"string","win":"A"},{"factor":"H2H","A":"string","B":"string","win":"B"},{"factor":"Lesionados","A":"string","B":"string","win":"A"},{"factor":"Goles marcados","A":"string","B":"string","win":"A"},{"factor":"Goles recibidos","A":"string","B":"string","win":"B"},{"factor":"Local vs Visitante","A":"string","B":"string","win":"A"},{"factor":"Motivacion","A":"string","B":"string","win":"A"},{"factor":"Tendencia","A":"string","B":"string","win":"B"}],"barA":[8,7,6,5],"barB":[5,4,7,6],"barLabels":["Forma","Ataque","Defensa","Local"],"pie":[52,20,28],"radarA":[8,6,7,8,6],"radarB":[5,7,5,4,7],"radarLabels":["Ataque","Defensa","Forma","Local","Plantilla"],"telegramPost":"string","whatsappPost":"string"}
REGLAS: odds minimo 1.4. risk solo BAJO MEDIO o ALTO. win solo A B o draw. pie suma 100. SOLO JSON puro.`;

  const res = await fetch(`${base}/claude`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-claude-key": claudeKey,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      system: sys,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Claude proxy error ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.content?.[0]?.text || "";
}

// ─── UI Components ────────────────────────────────────────────────────────────

const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "16px 18px", marginBottom: 14 };
const inp = { width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit" };

function Badge({ children, color = "#1D9E75" }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 20, fontSize: 11, background: color + "22", color, fontWeight: 600, border: `1px solid ${color}44` }}>{children}</span>;
}

function FormPills({ form }) {
  const col = { W: ["#dcfce7", "#15803d"], D: ["#fef9c3", "#854d0e"], L: ["#fee2e2", "#b91c1c"] };
  return (
    <div style={{ display: "flex", gap: 3 }}>
      {[...(form || "-----")].map((c, i) => (
        <span key={i} style={{ width: 22, height: 22, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, background: (col[c] || ["#f3f4f6", "#9ca3af"])[0], color: (col[c] || ["#f3f4f6", "#9ca3af"])[1] }}>{c}</span>
      ))}
    </div>
  );
}

function ConfBar({ value }) {
  const color = value >= 75 ? "#1D9E75" : value >= 55 ? "#BA7517" : "#E24B4A";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9ca3af", marginBottom: 4 }}>
        <span>Confianza IA</span><span style={{ fontWeight: 700, color }}>{value}%</span>
      </div>
      <div style={{ height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: 3, transition: "width 1s ease" }} />
      </div>
    </div>
  );
}

function CompTable({ d }) {
  const items = d.items || [];
  const sA = items.filter(i => i.win === "A").length;
  const sB = items.filter(i => i.win === "B").length;
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 1fr", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
        {[{ name: d.teamA, score: sA, side: "left" }, null, { name: d.teamB, score: sB, side: "right" }].map((t, i) => {
          if (!t) return <div key="m" style={{ padding: "12px 8px", textAlign: "center", borderLeft: "1px solid #e5e7eb", borderRight: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "center" }}><span style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".06em" }}>Factor</span></div>;
          const w = i === 0 ? sA >= sB : sB >= sA;
          return <div key={i} style={{ padding: "12px 14px", textAlign: t.side }}><div style={{ fontSize: 13, fontWeight: 700, color: w ? "#1D9E75" : "#6b7280" }}>{t.name}</div><div style={{ fontSize: 24, fontWeight: 700, color: w ? "#1D9E75" : "#6b7280" }}>{t.score}<span style={{ fontSize: 11, fontWeight: 400 }}> pts</span></div></div>;
        })}
      </div>
      {items.map((item, idx) => (
        <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 110px 1fr", borderBottom: idx < items.length - 1 ? "1px solid #f3f4f6" : "none", background: idx % 2 === 0 ? "#fff" : "#fafafa" }}>
          <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", gap: 5, borderRight: "1px solid #f3f4f6" }}>
            {item.win === "A" && <span style={{ color: "#1D9E75", fontWeight: 700 }}>✓</span>}
            <span style={{ fontSize: 12, color: item.win === "A" ? "#111827" : "#9ca3af", fontWeight: item.win === "A" ? 600 : 400 }}>{item.A}</span>
          </div>
          <div style={{ padding: "9px 8px", textAlign: "center", borderRight: "1px solid #f3f4f6" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{item.factor}</div>
          </div>
          <div style={{ padding: "9px 14px", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5 }}>
            <span style={{ fontSize: 12, color: item.win === "B" ? "#111827" : "#9ca3af", fontWeight: item.win === "B" ? 600 : 400, textAlign: "right" }}>{item.B}</span>
            {item.win === "B" && <span style={{ color: "#1D9E75", fontWeight: 700 }}>✓</span>}
          </div>
        </div>
      ))}
      <div style={{ padding: "10px 14px", background: "#f9fafb", borderTop: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11, color: "#6b7280", minWidth: 50 }}>{d.teamA}</span>
        <div style={{ flex: 1, height: 6, background: "#e5e7eb", borderRadius: 3, overflow: "hidden", display: "flex" }}>
          <div style={{ width: `${(sA / (sA + sB + 0.01)) * 100}%`, background: "#1D9E75", transition: "width 1s" }} />
          <div style={{ flex: 1, background: "#378ADD" }} />
        </div>
        <span style={{ fontSize: 11, color: "#6b7280", minWidth: 50, textAlign: "right" }}>{d.teamB}</span>
      </div>
    </div>
  );
}

function Charts({ d }) {
  const tip = { contentStyle: { borderRadius: 8, fontSize: 12, border: "1px solid #e5e7eb" } };
  const barData = (d.barLabels || []).map((name, i) => ({ name, A: d.barA?.[i] ?? 0, B: d.barB?.[i] ?? 0 }));
  const pieData = [
    { name: `Victoria ${d.teamA}`, value: d.pie?.[0] ?? 40 },
    { name: "Empate", value: d.pie?.[1] ?? 25 },
    { name: `Victoria ${d.teamB}`, value: d.pie?.[2] ?? 35 },
  ];
  const radarData = (d.radarLabels || []).map((subject, i) => ({ subject, A: d.radarA?.[i] ?? 5, B: d.radarB?.[i] ?? 5 }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={{ ...card, marginBottom: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10 }}>Estadísticas comparadas</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={barData} barSize={14}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 10]} tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} width={18} />
              <Tooltip {...tip} />
              <Bar dataKey="A" name={d.teamA} fill="#1D9E75" radius={[3, 3, 0, 0]} />
              <Bar dataKey="B" name={d.teamB} fill="#378ADD" radius={[3, 3, 0, 0]} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={{ ...card, marginBottom: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10 }}>Probabilidades</div>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={42} outerRadius={62} paddingAngle={3} dataKey="value">
                {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
              </Pie>
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 10 }}>Radar — perfil global</div>
        <ResponsiveContainer width="100%" height={200}>
          <RadarChart data={radarData}>
            <PolarGrid stroke="#e5e7eb" />
            <PolarAngleAxis dataKey="subject" tick={{ fontSize: 12, fill: "#6b7280" }} />
            <PolarRadiusAxis domain={[0, 10]} tick={false} axisLine={false} />
            <Radar name={d.teamA} dataKey="A" stroke="#1D9E75" fill="#1D9E75" fillOpacity={0.2} />
            <Radar name={d.teamB} dataKey="B" stroke="#378ADD" fill="#378ADD" fillOpacity={0.2} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PostBox({ d }) {
  const [mode, setMode] = useState("tg");
  const [copied, setCopied] = useState(false);
  const text = mode === "tg" ? (d.telegramPost || "") : (d.whatsappPost || "");
  const copy = () => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <div style={card}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 12 }}>Post listo para publicar</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {[["tg", "✈️ Telegram"], ["wa", "💬 WhatsApp"]].map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${mode === k ? "#1D9E75" : "#e5e7eb"}`, background: mode === k ? "#f0fdf4" : "transparent", color: mode === k ? "#1D9E75" : "#6b7280", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>{l}</button>
        ))}
        <button onClick={copy} style={{ marginLeft: "auto", padding: "6px 14px", borderRadius: 8, border: "1px solid #e5e7eb", background: "transparent", color: "#6b7280", fontSize: 12, cursor: "pointer" }}>
          {copied ? "✓ Copiado" : "📋 Copiar"}
        </button>
      </div>
      <div style={{ background: "#f9fafb", borderRadius: 10, padding: "14px 16px", fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", maxWidth: 360, margin: "0 auto", border: "1px solid #f3f4f6" }}>{text}</div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState("analyze");
  const [cfg, setCfg] = useState({ workerUrl: "", apiKey: "", claudeKey: "" });
  const [form, setForm] = useState({ a: "", b: "", comp: "", date: "", ctx: "" });
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState("");
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [workerOk, setWorkerOk] = useState(null);

  useEffect(() => {
    const saved = loadConfig();
    if (Object.keys(saved).length) setCfg(prev => ({ ...prev, ...saved }));
  }, []);

  const saveCfg = (newCfg) => { setCfg(newCfg); saveConfig(newCfg); };
  const setF = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const hasProxy = cfg.workerUrl.trim() && cfg.claudeKey.trim();
  const hasRealData = hasProxy && cfg.apiKey.trim();
  const riskColor = { BAJO: "#1D9E75", MEDIO: "#BA7517", ALTO: "#E24B4A" };

  const testWorker = async () => {
    setWorkerOk(null);
    try {
      const res = await fetch(`${cfg.workerUrl.replace(/\/$/, "")}/health`);
      const d = await res.json();
      setWorkerOk(d.status === "ok");
    } catch { setWorkerOk(false); }
  };

  const analyze = async () => {
    if (!form.a || !form.b) { setErr("Ingresa los dos equipos."); return; }
    if (!cfg.workerUrl || !cfg.claudeKey) { setErr("Configura el Worker y la Claude API Key en ⚙️ Config."); return; }
    setErr(""); setData(null); setLoading(true);
    let realStats = null;

    try {
      // ── Fetch real data if API-Football key available ──
      if (hasRealData) {
        try {
          setStep("🔍 Buscando equipos en la base de datos...");
          const [tA, tB] = await Promise.all([
            searchTeam(form.a, cfg.workerUrl, cfg.apiKey),
            searchTeam(form.b, cfg.workerUrl, cfg.apiKey)
          ]);
          if (tA && tB) {
            const idA = tA.team.id, idB = tB.team.id;
            setStep("📊 Obteniendo estadísticas, H2H y lesionados...");
            const [fA, fB, h2h, injA, injB] = await Promise.all([
              getLastFixtures(idA, cfg.workerUrl, cfg.apiKey),
              getLastFixtures(idB, cfg.workerUrl, cfg.apiKey),
              getH2H(idA, idB, cfg.workerUrl, cfg.apiKey),
              getInjuries(idA, cfg.workerUrl, cfg.apiKey),
              getInjuries(idB, cfg.workerUrl, cfg.apiKey),
            ]);
            const formA = parseForm(fA, idA), formB = parseForm(fB, idB);
            const goalsA = fA.reduce((s, f) => s + ((f.teams.home.id === idA ? f.goals.home : f.goals.away) || 0), 0);
            const goalsB = fB.reduce((s, f) => s + ((f.teams.home.id === idB ? f.goals.home : f.goals.away) || 0), 0);
            const concA  = fA.reduce((s, f) => s + ((f.teams.home.id === idA ? f.goals.away : f.goals.home) || 0), 0);
            const concB  = fB.reduce((s, f) => s + ((f.teams.home.id === idB ? f.goals.away : f.goals.home) || 0), 0);
            const h2hWinsA = h2h.filter(f => f.teams.home.id === idA ? (f.goals.home||0) > (f.goals.away||0) : (f.goals.away||0) > (f.goals.home||0)).length;
            const h2hWinsB = h2h.filter(f => f.teams.home.id === idB ? (f.goals.home||0) > (f.goals.away||0) : (f.goals.away||0) > (f.goals.home||0)).length;
            const injNamesA = injA.slice(0,4).map(p=>p.player?.name||"?").join(", ") || "Ninguno reportado";
            const injNamesB = injB.slice(0,4).map(p=>p.player?.name||"?").join(", ") || "Ninguno reportado";
            const resultsA = fA.slice(0,5).map(f=>{const h=f.teams.home.id===idA;return `${h?f.teams.away.name:f.teams.home.name} ${h?f.goals.home:f.goals.away}-${h?f.goals.away:f.goals.home}`;}).join(" | ");
            const resultsB = fB.slice(0,5).map(f=>{const h=f.teams.home.id===idB;return `${h?f.teams.away.name:f.teams.home.name} ${h?f.goals.home:f.goals.away}-${h?f.goals.away:f.goals.home}`;}).join(" | ");
            realStats = { teamAName:tA.team.name, teamBName:tB.team.name, formA, formB, goalsA, goalsB, concA, concB, h2hWinsA, h2hWinsB, h2hTotal:h2h.length, injA:injNamesA, injB:injNamesB, injCountA:injA.length, injCountB:injB.length, resultsA, resultsB, scoreA:formScore(formA), scoreB:formScore(formB) };
          }
        } catch (e) { console.warn("API-Football:", e.message); }
      }

      setStep("🧠 Generando análisis con IA...");
      const prompt = realStats
        ? `Analiza con estos DATOS REALES de API-Football:\n\nPARTIDO: ${realStats.teamAName} (LOCAL) vs ${realStats.teamBName} (VISITANTE)\nCompetición: ${form.comp||"no especificada"} | Fecha: ${form.date||"próxima"}\n\n📊 DATOS REALES:\n• Forma últimos 5 → ${realStats.teamAName}: ${realStats.formA} (${realStats.scoreA}pts) | ${realStats.teamBName}: ${realStats.formB} (${realStats.scoreB}pts)\n• Goles marcados (últ.5) → ${realStats.teamAName}: ${realStats.goalsA} | ${realStats.teamBName}: ${realStats.goalsB}\n• Goles recibidos (últ.5) → ${realStats.teamAName}: ${realStats.concA} | ${realStats.teamBName}: ${realStats.concB}\n• H2H (${realStats.h2hTotal} partidos) → ${realStats.teamAName} ganó ${realStats.h2hWinsA} | ${realStats.teamBName} ganó ${realStats.h2hWinsB}\n• Lesionados ${realStats.teamAName} (${realStats.injCountA}): ${realStats.injA}\n• Lesionados ${realStats.teamBName} (${realStats.injCountB}): ${realStats.injB}\n• Últimos resultados ${realStats.teamAName}: ${realStats.resultsA}\n• Últimos resultados ${realStats.teamBName}: ${realStats.resultsB}\n• Contexto extra: ${form.ctx||"ninguno"}\n\nDame la mejor apuesta con cuota mínima 1.4.`
        : `Partido: ${form.a} (local) vs ${form.b} (visitante). Competición: ${form.comp||"no especificada"}. Fecha: ${form.date||"próxima"}. Contexto: ${form.ctx||"ninguno"}. Mejor apuesta cuota ≥ 1.4.`;

      const raw = await callClaude(prompt, cfg.workerUrl, cfg.claudeKey);
      const parsed = safeJSON(raw);
      if (!parsed) { setErr("La IA no devolvió respuesta válida. Intenta de nuevo."); return; }
      parsed.teamA = realStats?.teamAName || form.a;
      parsed.teamB = realStats?.teamBName || form.b;
      parsed.competition = form.comp || "Partido";
      parsed.hasRealData = !!realStats;
      if (realStats) { parsed.formA = realStats.formA; parsed.formB = realStats.formB; }
      setData(parsed);
      setTab("result");
    } catch (e) { setErr("Error: " + e.message); }
    finally { setLoading(false); setStep(""); }
  };

  const T = ({ t, l }) => (
    <button onClick={() => setTab(t)} style={{ padding: "6px 13px", borderRadius: 8, border: `1px solid ${tab===t?"#1D9E75":"#e5e7eb"}`, background: tab===t?"#f0fdf4":"transparent", color: tab===t?"#1D9E75":"#6b7280", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{l}</button>
  );

  return (
    <div style={{ fontFamily: "system-ui,sans-serif", maxWidth: 740, margin: "0 auto", padding: "16px 12px", minHeight: "100vh", background: "#f9fafb" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: "#fff", padding: "14px 20px", borderRadius: 12, marginBottom: 16, boxShadow: "0 1px 3px #0001", flexWrap: "wrap" }}>
        <div style={{ width: 40, height: 40, background: "#1D9E75", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>⚡</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>BETIQ PRO</div>
          <div style={{ fontSize: 12, color: "#9ca3af" }}>IA + Datos reales · Liga colombiana, Libertadores, Champions y más · Cuotas ≥ 1.4</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 5, flexWrap: "wrap" }}>
          <T t="analyze" l="🔍 Analizar" />
          <T t="result"  l="📊 Resultado" />
          <T t="setup"   l="⚙️ Config" />
          <T t="premium" l="👑 Premium" />
        </div>
      </div>

      {/* ── SETUP ── */}
      {tab === "setup" && (
        <div>
          <div style={{ ...card, borderColor: "#bae6fd", background: "#f0f9ff" }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>☁️ URL del Cloudflare Worker <span style={{ color: "#b91c1c" }}>*requerido</span></div>
            <div style={{ fontSize: 13, color: "#374151", marginBottom: 8 }}>El Worker actúa de puente para Claude y API-Football.</div>
            <input style={inp} placeholder="https://cold-bar-717e.adserobles.workers.dev" value={cfg.workerUrl} onChange={e => saveCfg({ ...cfg, workerUrl: e.target.value })} />
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              <button onClick={testWorker} disabled={!cfg.workerUrl} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #1D9E75", background: "#f0fdf4", color: "#1D9E75", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>🔌 Probar conexión</button>
              {workerOk === true  && <span style={{ color: "#1D9E75", fontWeight: 600 }}>✅ Conectado correctamente</span>}
              {workerOk === false && <span style={{ color: "#b91c1c", fontWeight: 600 }}>❌ No se conectó — revisa la URL</span>}
            </div>
          </div>

          <div style={{ ...card, borderColor: "#d8b4fe", background: "#faf5ff" }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>🤖 Claude API Key <span style={{ color: "#b91c1c" }}>*requerido</span></div>
            <div style={{ fontSize: 13, color: "#374151", marginBottom: 8 }}>Obtén en <strong>console.anthropic.com</strong> → API Keys → Create Key</div>
            <input style={{ ...inp, fontFamily: "monospace", fontSize: 12 }} type="password" placeholder="sk-ant-api03-..." value={cfg.claudeKey} onChange={e => saveCfg({ ...cfg, claudeKey: e.target.value })} />
          </div>

          <div style={{ ...card, borderColor: "#d1fae5", background: "#f0fdf4" }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>📡 API Key de API-Football <span style={{ color: "#6b7280", fontWeight: 400 }}>(opcional — para datos reales)</span></div>
            <div style={{ fontSize: 13, color: "#374151", marginBottom: 8 }}>Obtén en <strong>dashboard.api-football.com</strong> → Account → My Access. Plan gratis: 100 req/día.</div>
            <input style={{ ...inp, fontFamily: "monospace", fontSize: 12 }} type="password" placeholder="Tu API key alfanumérica..." value={cfg.apiKey} onChange={e => saveCfg({ ...cfg, apiKey: e.target.value })} />
          </div>

          <button onClick={() => setTab("analyze")} style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", background: "#1D9E75", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
            ⚡ Ir a analizar partidos
          </button>
          <div style={{ textAlign: "center", fontSize: 12, color: "#9ca3af", marginTop: 8 }}>💾 La configuración se guarda automáticamente en tu navegador.</div>
        </div>
      )}

      {/* ── ANALYZE ── */}
      {tab === "analyze" && (
        <div>
          <div style={{ ...card, padding: "10px 14px", marginBottom: 14, background: hasRealData ? "#f0fdf4" : hasProxy ? "#f0f9ff" : "#fef2f2", borderColor: hasRealData ? "#bbf7d0" : hasProxy ? "#bae6fd" : "#fecaca" }}>
            <div style={{ fontSize: 13 }}>
              {hasRealData
                ? <span style={{ color: "#15803d" }}>📡 <strong>Datos reales activados</strong> — estadísticas, H2H y lesionados de API-Football en tiempo real.</span>
                : hasProxy
                ? <span style={{ color: "#0369a1" }}>🤖 <strong>Modo IA</strong> — Claude configurado. <button onClick={() => setTab("setup")} style={{ background: "none", border: "none", color: "#0369a1", textDecoration: "underline", cursor: "pointer", fontSize: 13, padding: 0 }}>Agrega API-Football para datos reales →</button></span>
                : <span style={{ color: "#b91c1c" }}>⚠️ <strong>Configuración incompleta.</strong> <button onClick={() => setTab("setup")} style={{ background: "none", border: "none", color: "#b91c1c", textDecoration: "underline", cursor: "pointer", fontSize: 13, padding: 0 }}>Configura el Worker y Claude API Key →</button></span>
              }
            </div>
          </div>

          <div style={card}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 14 }}>📋 Datos del partido</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 5 }}>🏠 Equipo local</label><input style={inp} value={form.a} onChange={setF("a")} placeholder="Ej: Santafe, Boca, Real Madrid..." /></div>
              <div><label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 5 }}>✈️ Equipo visitante</label><input style={inp} value={form.b} onChange={setF("b")} placeholder="Ej: America, River, Bayern..." /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <div><label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 5 }}>🏆 Competición</label><input style={inp} value={form.comp} onChange={setF("comp")} placeholder="Liga BetPlay, Libertadores..." /></div>
              <div><label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 5 }}>📅 Fecha</label><input style={inp} value={form.date} onChange={setF("date")} placeholder="Ej: 20/05/2026" /></div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: "#6b7280", display: "block", marginBottom: 5 }}>📝 Contexto — altitud, clima, suspendidos, noticias...</label>
              <textarea style={{ ...inp, resize: "vertical" }} value={form.ctx} onChange={setF("ctx")} rows={2} placeholder="Ej: El Campín lleno. El técnico confirmó que el capitán no juega..." />
            </div>
            {err && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#b91c1c", marginBottom: 10 }}>{err}</div>}
            {loading && step && <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#15803d", marginBottom: 10 }}>{step}</div>}
            <button onClick={analyze} disabled={loading} style={{ width: "100%", padding: 12, borderRadius: 8, border: "none", background: loading ? "#d1fae5" : "#1D9E75", color: loading ? "#065f46" : "#fff", fontWeight: 700, fontSize: 14, cursor: loading ? "not-allowed" : "pointer" }}>
              {loading ? (step || "⚡ Analizando...") : hasRealData ? "⚡ Analizar con datos reales" : "⚡ Analizar con IA"}
            </button>
          </div>
        </div>
      )}

      {/* ── RESULT empty ── */}
      {tab === "result" && !data && (
        <div style={{ ...card, textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📊</div>
          <div style={{ color: "#9ca3af", fontSize: 14 }}>Aún no hay análisis generado.</div>
          <button onClick={() => setTab("analyze")} style={{ marginTop: 14, padding: "8px 16px", borderRadius: 8, border: "1px solid #e5e7eb", background: "transparent", color: "#6b7280", cursor: "pointer", fontSize: 13 }}>← Ir a analizar</button>
        </div>
      )}

      {/* ── RESULT with data ── */}
      {tab === "result" && data && (
        <div>
          {data.hasRealData && (
            <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#0369a1" }}>
              📡 <strong>Análisis con datos reales</strong> — estadísticas, H2H y lesionados de API-Football.
            </div>
          )}
          <div style={card}>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 10 }}>
              <Badge color="#378ADD">⚽ {data.competition}</Badge>
              <Badge color={riskColor[data.risk]||"#1D9E75"}>Riesgo {data.risk}</Badge>
              <Badge color="#1D9E75">🎁 Free hoy</Badge>
              {data.hasRealData && <Badge color="#0ea5e9">📡 Datos reales</Badge>}
            </div>
            <div style={{ fontWeight: 700, fontSize: 22, marginBottom: data.hasRealData ? 10 : 14 }}>
              {data.teamA} <span style={{ color: "#9ca3af", fontWeight: 400 }}>vs</span> {data.teamB}
            </div>
            {data.hasRealData && (
              <div style={{ display: "flex", gap: 20, marginBottom: 14, flexWrap: "wrap" }}>
                <div><div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>{data.teamA} — últimos 5</div><FormPills form={data.formA} /></div>
                <div><div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>{data.teamB} — últimos 5</div><FormPills form={data.formB} /></div>
              </div>
            )}
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 14 }}>
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 22px", textAlign: "center", flexShrink: 0 }}>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>Cuota</div>
                <div style={{ fontSize: 34, fontWeight: 700, color: "#1D9E75" }}>{data.odds}</div>
              </div>
              <div style={{ flex: 1, minWidth: 140 }}>
                <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 5 }}>Apuesta sugerida</div>
                <div style={{ background: "#f0fdf4", color: "#1D9E75", fontWeight: 700, fontSize: 15, padding: "8px 14px", borderRadius: 8, display: "inline-block" }}>🎯 {data.bet}</div>
              </div>
              <div style={{ minWidth: 160, flex: 1 }}><ConfBar value={data.confidence||0} /></div>
            </div>
            <div style={{ background: "#f9fafb", borderRadius: 9, padding: "13px 15px", fontSize: 14, lineHeight: 1.7, color: "#374151", border: "1px solid #f3f4f6" }}>{data.verdict}</div>
          </div>

          <div style={card}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 12 }}>📌 Puntos clave</div>
            {(data.keyPoints||[]).map((p,i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "#f9fafb", borderRadius: 8, padding: "9px 12px", border: "1px solid #f3f4f6", marginBottom: 7 }}>
                <span style={{ fontWeight: 700, color: "#1D9E75", minWidth: 18, fontSize: 13 }}>{i+1}</span>
                <span style={{ fontSize: 13, lineHeight: 1.55, color: "#374151" }}>{p}</span>
              </div>
            ))}
          </div>

          <Charts d={data} />

          <div style={card}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 12 }}>⚖️ Factor a factor</div>
            <CompTable d={data} />
          </div>

          <PostBox d={data} />

          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
            <button onClick={() => { setData(null); setTab("analyze"); }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #e5e7eb", background: "transparent", color: "#6b7280", cursor: "pointer", fontSize: 13 }}>🔄 Nuevo análisis</button>
          </div>
        </div>
      )}

      {/* ── PREMIUM ── */}
      {tab === "premium" && (
        <div>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <Badge color="#BA7517">👑 Membresía premium</Badge>
            <div style={{ fontWeight: 700, fontSize: 22, marginTop: 12, marginBottom: 7 }}>Apuestas de élite con datos reales</div>
            <div style={{ fontSize: 13, color: "#9ca3af" }}>Estadísticas en tiempo real + IA de última generación, todos los días.</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 }}>
            {[
              { label:"Free", price:"$0/día", color:"#1D9E75", feats:["1 análisis por día","Cuota mínima 1.4","Post Telegram/WhatsApp","IA sin datos en vivo"], cta:"Usar ahora", action:()=>setTab("analyze"), hl:false },
              { label:"Premium", price:"$4.99/día", color:"#1D9E75", feats:["Datos reales API-Football","Forma, H2H y lesionados","Gráficas con datos reales","Post listo para publicar"], cta:"Comprar hoy", hl:true },
              { label:"Canal Mes", price:"$39.99/mes", color:"#378ADD", feats:["Todas las apuestas del mes","Canal privado Telegram","Alertas antes del partido","Soporte personalizado"], cta:"Unirse al canal", hl:false },
            ].map(p => (
              <div key={p.label} style={{ ...card, marginBottom:0, border:p.hl?"2px solid #1D9E75":"1px solid #e5e7eb" }}>
                <Badge color={p.color}>{p.label}</Badge>
                <div style={{ fontWeight:700, fontSize:22, margin:"10px 0 14px" }}>{p.price}</div>
                {p.feats.map(f => <div key={f} style={{ display:"flex", gap:7, fontSize:13, color:"#6b7280", marginBottom:7 }}><span style={{ color:"#1D9E75" }}>✓</span>{f}</div>)}
                <button onClick={p.action||undefined} style={{ width:"100%", marginTop:14, padding:10, borderRadius:8, border:"none", background:p.hl?"#1D9E75":"#f3f4f6", color:p.hl?"#fff":"#374151", fontWeight:700, fontSize:13, cursor:"pointer" }}>{p.cta}</button>
              </div>
            ))}
          </div>
          <div style={{ textAlign:"center", fontSize:12, color:"#9ca3af", marginTop:16 }}>Las apuestas son sugerencias estadísticas. Juega responsablemente.</div>
        </div>
      )}
    </div>
  );
}
