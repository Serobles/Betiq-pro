import { exigirSesion } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // 401 ANTES de tocar Anthropic: sin sesion valida no se gasta un token.
  const usuario = await exigirSesion(req, res);
  if (!usuario) return;

  const { system, messages, withSearch, maxTokens } = req.body;

  if (!system || !messages) {
    return res.status(400).json({ error: "Faltan parámetros requeridos" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada" });
  }

  const body = {
    model: "claude-sonnet-4-6",
    // Cap del SERVIDOR: lo que pida el cliente por encima del tope actual
    // de la app se ignora — este endpoint paga la factura, no el navegador.
    max_tokens: Math.min(Number(maxTokens) || 4000, 4000),
    system,
    messages,
  };

  if (withSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
