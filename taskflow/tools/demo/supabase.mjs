/**
 * SÓLO PARA DESARROLLO. La app no importa nada de esta carpeta.
 *
 * Sirve por HTTP el Supabase de mentira de `fake-supabase.mjs`, para abrir la
 * app con datos sin crear ninguna cuenta. Todo lo interesante vive allá; esto
 * sólo traduce entre el servidor de Node y la función estilo `fetch`.
 */
import { createServer } from "node:http";
import { DEMO_USER, createFakeSupabase } from "./fake-supabase.mjs";

const PORT = Number(process.env.PORT || 7411);

// El equivalente de la service role key. `start.mjs` genera uno al azar en cada
// arranque y se lo pasa a los dos lados; aquí no hay ninguno escrito. Quien
// llega con él salta la RLS, igual que en Supabase de verdad: es lo que hace
// que `/api/sync` (el reloj, que corre sin sesión) se pueda probar en el demo.
const fake = await createFakeSupabase({ serviceKey: process.env.DEMO_SERVICE_KEY || null });
const USER_ID = fake.userId(DEMO_USER.email);
console.log(`usuario de prueba: ${DEMO_USER.email} / ${DEMO_USER.password}  (${USER_ID})`);

// Cabeceras que describen la conexión, no la petición: `Request` no las quiere.
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = Object.entries(req.headers)
    .filter(([k, v]) => !HOP.has(k) && v != null)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]);

  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" || !chunks.length ? undefined : Buffer.concat(chunks),
  });
  const response = await fake.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

// Un puerto ocupado es el tropiezo más probable al arrancar el demo, y el
// volcado de Node que sale por defecto no le dice a nadie qué hacer.
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\nEl puerto ${PORT} ya está ocupado.`);
    console.error("Seguramente hay otro demo corriendo. Ciérralo (Ctrl+C en su");
    console.error(`ventana) o usa otro puerto:  DEMO_PORT=7412 npm run demo\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake supabase escuchando en http://127.0.0.1:${PORT}`));
export { server, USER_ID };
export const db = fake.db;
