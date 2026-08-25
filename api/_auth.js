// Guard compartido de autenticacion para los endpoints que gastan dinero
// (analyze: tokens de Claude; football: cuota de API-Football).
// api/fixtures queda publico a proposito: el calendario es la portada.
// El prefijo _ excluye este fichero del enrutado de Vercel.
//
// Verifica el access_token de Supabase contra /auth/v1/user usando la anon
// key: no hace falta service key para preguntar "¿de quien es este JWT?" —
// si el token no es valido, Supabase responde 401 y aqui se corta ANTES de
// tocar ninguna API de pago.
export async function exigirSesion(req, res) {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !anon) {
    res.status(500).json({ error: "Supabase no configurado en el servidor" });
    return null;
  }

  const cabecera = req.headers.authorization || "";
  const token = cabecera.startsWith("Bearer ") ? cabecera.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Inicia sesión para usar este servicio" });
    return null;
  }

  const r = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    res.status(401).json({ error: "Sesión inválida o caducada. Vuelve a iniciar sesión." });
    return null;
  }

  return r.json();
}
