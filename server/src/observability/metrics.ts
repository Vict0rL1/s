// Métricas en formato texto de Prometheus (Fase 3.2), para `GET /api/metrics`.
//
// Sin dependencia: un contador es un mapa de etiquetas → número, y el formato de texto son
// tres líneas por métrica. Lo que vale la pena medir aquí es lo que no se ve desde fuera:
// cuántas predicciones se sirven, cuántas apuestas de papel hay, cuánta cuota de The Odds API
// queda y cuánto tardan los trabajos programados. Los valores de estado (apuestas, cuota,
// errores) se leen al raspar, no se acumulan: son el estado de la base, no de este proceso.

export type Etiquetas = Record<string, string | number>;

interface Serie {
  tipo: 'counter' | 'gauge';
  ayuda: string;
  valores: Map<string, { etiquetas: Etiquetas; valor: number }>;
}

const series = new Map<string, Serie>();
const claveDe = (e: Etiquetas) => Object.keys(e).sort().map((k) => `${k}=${e[k]}`).join(',');

function serie(nombre: string, tipo: Serie['tipo'], ayuda: string): Serie {
  let s = series.get(nombre);
  if (!s) {
    s = { tipo, ayuda, valores: new Map() };
    series.set(nombre, s);
  }
  return s;
}

export function incrementar(nombre: string, etiquetas: Etiquetas = {}, ayuda = '', n = 1): void {
  const s = serie(nombre, 'counter', ayuda);
  const k = claveDe(etiquetas);
  const v = s.valores.get(k);
  if (v) v.valor += n;
  else s.valores.set(k, { etiquetas, valor: n });
}

export function fijar(nombre: string, valor: number, etiquetas: Etiquetas = {}, ayuda = ''): void {
  const s = serie(nombre, 'gauge', ayuda);
  s.valores.set(claveDe(etiquetas), { etiquetas, valor });
}

/** Para los tests. */
export function reiniciarMetricas(): void {
  series.clear();
}

export function valorDe(nombre: string, etiquetas: Etiquetas = {}): number | null {
  return series.get(nombre)?.valores.get(claveDe(etiquetas))?.valor ?? null;
}

const escapar = (s: string | number) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** El texto que lee Prometheus: `# HELP`, `# TYPE` y una línea por combinación de etiquetas. */
export function renderPrometheus(): string {
  const lineas: string[] = [];
  for (const [nombre, s] of [...series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (s.ayuda) lineas.push(`# HELP ${nombre} ${escapar(s.ayuda)}`);
    lineas.push(`# TYPE ${nombre} ${s.tipo}`);
    for (const { etiquetas, valor } of s.valores.values()) {
      const et = Object.keys(etiquetas)
        .sort()
        .map((k) => `${k}="${escapar(etiquetas[k])}"`)
        .join(',');
      lineas.push(`${nombre}${et ? `{${et}}` : ''} ${Number.isFinite(valor) ? valor : 0}`);
    }
  }
  return lineas.join('\n') + '\n';
}

/** El grupo de una URL para no explotar las etiquetas con ids: `/api/football/fixtures/123` → `/api/football`. */
/**
 * La etiqueta `grupo` de una petición, a partir del PATRÓN de su ruta (`req.routeOptions.url`:
 * `/api/football/fixtures/:id`), nunca de la URL cruda (lote B, B6). Con la URL, cada ruta de
 * la SPA, cada `/wp-admin` y cada sondeo era una etiqueta nueva: cardinalidad sin tope en
 * memoria y en /api/metrics. Sin ruta (un 404) → `sin-ruta`; la comodín de la web → `estatico`.
 */
export function grupoDeRuta(ruta: string | null | undefined, _url?: string): string {
  if (!ruta) return 'sin-ruta';
  if (ruta === '/*') return 'estatico';
  const sinQuery = ruta.split('?')[0];
  const m = sinQuery.match(/^\/api\/([a-z-]+)(?:\/([a-z-]+))?/);
  if (!m) return sinQuery.startsWith('/docs') ? '/docs' : sinQuery === '/' ? '/' : sinQuery.replace(/\/(:|\*).*$/, '');
  const deportes = new Set(['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'bets', 'auth', 'latency', 'staking', 'notifications', 'export', 'scheduler', 'policy', 'datos']);
  return deportes.has(m[1]) ? `/api/${m[1]}` : `/api/${m[1]}${m[2] ? `/${m[2]}` : ''}`;
}
