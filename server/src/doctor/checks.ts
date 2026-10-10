// Las comprobaciones de `npm run doctor`, separadas de la impresión.
//
// Cada comprobación devuelve HALLAZGOS: sección, nivel, texto y —si hay algo que hacer—
// la acción. El script solo los imprime y decide el resultado. Separarlo así tiene una
// razón concreta: el doctor anterior era un único fichero que imprimía mientras
// comprobaba, y por eso no se podía probar; un diagnóstico sin tests puede decir «todo
// correcto» con la misma confianza cuando está roto.
//
// Las que no necesitan red ni disco son funciones PURAS (reciben lo que miran), y son
// las que fijan los tests de doctor/checks.test.ts.

import { ACCION_POR_FALLO, classifyFailure, type KeyOutcome, type OddsApiFailure } from '../oddsApi.ts';

export type Nivel = 'ok' | 'aviso' | 'error' | 'info';
export type Seccion =
  | 'CONFIGURACIÓN'
  | 'THE ODDS API'
  | 'DEPORTES'
  | 'BASE DE DATOS'
  | 'ACTUALIZACIÓN'
  | 'CONFIANZA'
  | 'DATOS Y COPIAS'
  | 'OPERACIÓN'
  | 'ANALÍTICA E INTERFAZ'
  | 'PRODUCTO'
  | 'SEGURIDAD'
  | 'SERVIDOR Y PANTALLA';

export interface Hallazgo {
  seccion: Seccion;
  nivel: Nivel;
  texto: string;
  /** Líneas de contexto bajo el texto. */
  detalle?: string[];
  /** Qué hacer, en líneas que se pueden copiar. Solo en avisos y errores. */
  accion?: string[];
}

const h = (seccion: Seccion, nivel: Nivel, texto: string, extra: Partial<Hallazgo> = {}): Hallazgo => ({
  seccion,
  nivel,
  texto,
  ...extra,
});

/** Nunca se imprime una clave entera: solo longitud y los cuatro últimos. */
export function enmascarar(clave: string): string {
  return clave.length <= 4 ? '••••' : `••••${clave.slice(-4)}`;
}

// ===========================================================================
// CONFIGURACIÓN
// ===========================================================================

export const REGIONES_VALIDAS = ['us', 'us2', 'uk', 'eu', 'au'];

export interface EntradaConfig {
  envPath: string;
  envExiste: boolean;
  /** El .env tal cual, para diagnosticar la línea CRUDA y no lo que dotenv entendió. */
  envCrudo: string;
  /** Otros .env que existen y la app NO lee (carpeta de al lado, server/, web/…). */
  otrosEnv: string[];
  /** Lo que dotenv sacó del fichero. */
  valoresFichero: Record<string, string>;
  /** Lo que la app ve de verdad, después de dotenv (process.env). */
  valoresProceso: Record<string, string | undefined>;
  /** La clave resuelta y el nombre de variable del que salió. */
  clave: { value: string; name: string | null };
  regiones: string;
  zonaHoraria: string;
  /** Minutos de diferencia con UTC (positivo = por delante), para decirlo en claro. */
  offsetMin: number;
}

export function comprobarConfiguracion(e: EntradaConfig): Hallazgo[] {
  const S: Seccion = 'CONFIGURACIÓN';
  const out: Hallazgo[] = [];

  if (e.envExiste) out.push(h(S, 'ok', `.env encontrado en ${e.envPath}`));
  else {
    out.push(
      h(S, 'error', `No hay .env en ${e.envPath}`, {
        detalle: ['La app lee el .env de la raíz del proyecto, la misma carpeta que package.json.'],
        accion: ['npm run clave   # crea el .env y pone tu clave (o: cp .env.example .env y escríbela en ODDS_API_KEY=)'],
      }),
    );
  }
  for (const p of e.otrosEnv) {
    out.push(
      h(S, e.envExiste ? 'aviso' : 'error', `Hay OTRO .env en ${p} que la app NO lee`, {
        accion: e.envExiste ? [`# si tu clave está ahí, cópiala al de la raíz: ${e.envPath}`] : [`cp "${p}" "${e.envPath}"`],
      }),
    );
  }

  // La línea cruda: los fallos de formato que dotenv traga en silencio.
  const lineas = e.envCrudo.split(/\n/);
  const linea = lineas.find((l) => /^\s*(export\s+)?(THE_)?ODDS_API_KEY\s*=/.test(l));
  if (linea) {
    const valor = linea.slice(linea.indexOf('=') + 1);
    if (/^\s*export\s/.test(linea)) {
      out.push(h(S, 'aviso', 'La línea de la clave empieza por `export`: un .env no es un script de shell', { accion: [`nano "${e.envPath}"`] }));
    }
    if (e.envCrudo.includes('\r')) {
      out.push(
        h(S, 'error', 'El .env tiene saltos de línea de Windows (\\r\\n): se pega un \\r al final de la clave', {
          accion: [`tr -d '\\r' < "${e.envPath}" > "${e.envPath}.tmp" && mv "${e.envPath}.tmp" "${e.envPath}"`],
        }),
      );
    }
    if (/^\s*["']|["']\s*$/.test(valor)) {
      out.push(h(S, 'aviso', 'La clave está entre comillas: quítalas, va sin nada alrededor', { accion: [`nano "${e.envPath}"`] }));
    }
  } else if (e.envExiste && lineas.some((l) => /^[A-Za-z0-9_-]{16,}$/.test(l.trim()))) {
    out.push(
      h(S, 'error', 'Hay una línea que parece tu clave, pero sin `ODDS_API_KEY=` delante', {
        detalle: ['Un .env es una lista de NOMBRE=valor: una línea sin nombre se ignora entera.'],
        accion: ['npm run clave   # la pega bien, con su nombre delante', `# o a mano: nano "${e.envPath}" y escribe ODDS_API_KEY= delante de la clave`],
      }),
    );
  }

  // La clave que la app VE.
  if (!e.clave.value) {
    out.push(
      h(S, 'error', 'ODDS_API_KEY no encontrada: la app arrancará en modo demostración', {
        accion: ['npm run clave   # la pide sin enseñarla, la escribe en el .env y la comprueba', '# y reinicia el servidor: npm run dev'],
      }),
    );
  } else {
    out.push(
      h(S, 'ok', `API key detectada en ${e.clave.name} (${e.clave.value.length} caracteres, ${enmascarar(e.clave.value)})`),
    );
    if (!/^[0-9a-f]{32}$/i.test(e.clave.value)) {
      out.push(
        h(S, 'aviso', 'La clave no tiene la forma habitual de The Odds API (32 caracteres hexadecimales)', {
          detalle: ['Puede estar bien; si THE ODDS API la rechaza más abajo, empieza por aquí.'],
        }),
      );
    }
  }

  // LA TERMINAL PISA AL .ENV. dotenv no sobrescribe una variable que ya existe, así que
  // un `export ODDS_API_KEY=...` viejo (o vacío) en ~/.zshrc gana sin decir nada.
  for (const nombre of ['ODDS_API_KEY', 'THE_ODDS_API_KEY']) {
    const fichero = e.valoresFichero[nombre];
    const proceso = e.valoresProceso[nombre];
    if (fichero != null && proceso != null && fichero.trim() !== proceso.trim()) {
      out.push(
        h(S, 'error', `La terminal tiene ${nombre} con OTRO valor y gana sobre el .env`, {
          detalle: [
            `.env: ${fichero.trim() ? enmascarar(fichero.trim()) : '(vacía)'} · terminal: ${proceso.trim() ? enmascarar(proceso.trim()) : '(vacía)'}`,
            'dotenv no sobrescribe variables que ya existen en la terminal.',
          ],
          accion: [`unset ${nombre}`, `grep -n ${nombre} ~/.zshrc ~/.bash_profile ~/.bashrc 2>/dev/null   # y bórrala de ahí`],
        }),
      );
    }
  }
  if (e.valoresFichero.ODDS_API_KEY && e.valoresFichero.THE_ODDS_API_KEY &&
      e.valoresFichero.ODDS_API_KEY.trim() !== e.valoresFichero.THE_ODDS_API_KEY.trim()) {
    out.push(
      h(S, 'aviso', 'El .env tiene ODDS_API_KEY y THE_ODDS_API_KEY con valores distintos; manda ODDS_API_KEY', {
        accion: [`nano "${e.envPath}"   # deja una sola`],
      }),
    );
  }

  const malas = e.regiones.split(',').map((r) => r.trim()).filter((r) => r && !REGIONES_VALIDAS.includes(r));
  if (malas.length > 0 || !e.regiones.trim()) {
    out.push(
      h(S, 'error', `ODDS_REGIONS="${e.regiones}" no es válido (la API responderá 422)`, {
        detalle: [`Valores válidos: ${REGIONES_VALIDAS.join(', ')}, separados por comas.`],
        accion: [`# en .env: ODDS_REGIONS=eu`],
      }),
    );
  } else {
    out.push(h(S, 'ok', `Regiones de casas: ${e.regiones} (cada región cuesta un crédito por mercado)`));
  }

  const signo = e.offsetMin >= 0 ? '+' : '−';
  const hh = String(Math.floor(Math.abs(e.offsetMin) / 60)).padStart(2, '0');
  const mm = String(Math.abs(e.offsetMin) % 60).padStart(2, '0');
  out.push(
    h(S, 'ok', `Zona horaria: ${e.zonaHoraria} (UTC${signo}${hh}:${mm}). Las horas se guardan en UTC y se muestran en esta zona.`),
  );
  return out;
}

// ===========================================================================
// THE ODDS API
// ===========================================================================

export interface Listado {
  /** null = no se pudo conectar. */
  status: number | null;
  cuerpo: string;
  restantes: number | null;
  usados: number | null;
  ms: number | null;
  errorRed: string | null;
  deportes: { key: string; group?: string; title?: string; active: boolean; has_outrights?: boolean }[] | null;
}

export interface EntradaApi {
  hayClave: boolean;
  sinRed: boolean;
  listado: Listado | null;
  plan: number | null;
  ritmo: { ok: true } | { ok: false; reason: string };
  gastoPorCiclo: number | null;
  minutosEntreCiclos: number;
}

export function interpretarApi(e: EntradaApi): Hallazgo[] {
  const S: Seccion = 'THE ODDS API';
  if (!e.hayClave) return [h(S, 'info', 'Sin clave: no hay nada que comprobar contra el proveedor.')];
  if (e.sinRed) return [h(S, 'info', '--sin-red: me salto la comprobación contra el proveedor.')];
  const l = e.listado;
  if (!l || l.status == null) {
    return [
      h(S, 'error', `No hay conexión con The Odds API${l?.errorRed ? `: ${l.errorRed}` : ''}`, {
        accion: [ACCION_POR_FALLO.sin_red],
      }),
    ];
  }
  if (l.status !== 200) {
    const f = classifyFailure(l.status, l.cuerpo);
    return [h(S, 'error', f.message, { detalle: l.cuerpo ? [l.cuerpo.slice(0, 200)] : [], accion: [ACCION_POR_FALLO[f.kind]] })];
  }
  const out: Hallazgo[] = [
    h(S, 'ok', 'API key válida'),
    h(S, 'ok', `API responde${l.ms != null ? ` (${l.ms} ms)` : ''} · la comprobación no gasta créditos`),
  ];
  if (l.restantes != null) {
    const nivel: Nivel = l.restantes <= 0 ? 'error' : l.restantes < 50 ? 'aviso' : 'ok';
    out.push(
      h(S, nivel, `Créditos restantes: ${l.restantes}${l.usados != null ? ` · usados este mes: ${l.usados}` : ''}${e.plan ? ` · plan: ${e.plan}` : ''}`, {
        accion: nivel === 'ok' ? undefined : [ACCION_POR_FALLO.sin_creditos],
      }),
    );
  } else {
    out.push(h(S, 'aviso', 'El proveedor no devolvió las cabeceras de cupo (x-requests-remaining)'));
  }
  if (e.gastoPorCiclo != null) {
    const porDia = e.minutosEntreCiclos > 0 ? Math.round((e.gastoPorCiclo * 1440) / e.minutosEntreCiclos) : null;
    const dias = l.restantes != null && porDia ? Math.floor(l.restantes / porDia) : null;
    out.push(
      h(S, 'info', `Gasto estimado: ${e.gastoPorCiclo} créditos por actualización` +
        (porDia != null ? ` · ~${porDia}/día con el refresco automático` : ' · refresco automático apagado') +
        (dias != null ? ` · alcanza para ~${dias} días` : '')),
    );
  }
  if (!e.ritmo.ok) {
    out.push(
      h(S, 'aviso', 'El freno de ritmo de la app está deteniendo el refresco AUTOMÁTICO', {
        detalle: [e.ritmo.reason, 'No es un límite del proveedor: es la app repartiendo el plan a lo largo del mes.'],
        accion: ['npm run odds   # a mano se salta el freno'],
      }),
    );
  } else if (e.plan != null) {
    out.push(h(S, 'ok', 'Presupuesto mensual dentro del límite (el freno de ritmo no está activo)'));
  }
  return out;
}

// ===========================================================================
// DEPORTES
// ===========================================================================

export interface DeporteConfig {
  nombre: string;
  claves: string[];
  /** Lo que contestó cada competición en la última descarga (vacío = nunca). */
  ultimas: KeyOutcome[];
  /** Resultado de `--probar`, si se pidió. */
  sondeo?: { key: string; eventos: number; conPrecio: number; casas: string[]; mercados: string[] } | { key: string; error: string; kind: OddsApiFailure | 'presupuesto' } | null;
}

export function comprobarDeportes(
  deportes: DeporteConfig[],
  listado: Listado['deportes'],
  hayClave = true,
): Hallazgo[] {
  const S: Seccion = 'DEPORTES';
  // Sin clave, que ningún deporte tenga descargas es la CONSECUENCIA del error de arriba,
  // no cinco problemas más. Repetirlo cinco veces entierra la única acción que importa.
  if (!hayClave) return [h(S, 'info', 'Sin clave no se descarga ningún deporte: ver CONFIGURACIÓN.')];
  const out: Hallazgo[] = [];
  const activas = new Set((listado ?? []).filter((s) => s.active).map((s) => s.key));
  const todas = new Set((listado ?? []).map((s) => s.key));

  for (const d of deportes) {
    const nombre = d.nombre.padEnd(10);
    const enJuego = d.claves.filter((k) => activas.has(k));
    const detalle: string[] = [];
    let nivel: Nivel = 'ok';
    let texto: string;

    if (listado && enJuego.length === 0) {
      const apagadas = d.claves.filter((k) => todas.has(k));
      texto = `${nombre} ninguna competición en juego ahora mismo${apagadas.length ? ` (fuera de temporada: ${apagadas.slice(0, 4).join(', ')})` : ''}`;
      nivel = 'info';
    } else {
      // La última descarga: la evidencia por competición.
      const ok = d.ultimas.filter((o) => o.ok);
      const fallos = d.ultimas.filter((o) => !o.ok);
      if (d.ultimas.length === 0) {
        texto = `${nombre} ${listado ? `${enJuego.length} competición(es) en juego · ` : ''}todavía sin descarga con clave`;
        nivel = 'aviso';
      } else {
        const ev = ok.reduce((a, o) => a + o.eventos, 0);
        const cp = ok.reduce((a, o) => a + o.conPrecio, 0);
        texto = `${nombre} ${ev} eventos / ${cp} con cuotas`;
        if (ev === 0 && fallos.length === 0) texto += ' · sin partidos con precio ahora';
        if (cp < ev) nivel = 'aviso';
        if (fallos.length > 0) nivel = ok.length ? 'aviso' : 'error';
      }
      for (const o of fallos) detalle.push(`${o.key}: ${o.message ?? o.kind}`);
      for (const o of ok.filter((x) => x.eventos > x.conPrecio)) {
        detalle.push(`${o.key}: ${o.eventos - o.conPrecio} evento(s) sin ninguna casa en tus regiones`);
      }
    }
    if (d.sondeo) {
      if ('error' in d.sondeo) {
        detalle.push(`sondeo ${d.sondeo.key}: ✗ ${d.sondeo.error}`);
        nivel = 'error';
      } else {
        detalle.push(
          `sondeo ${d.sondeo.key}: ${d.sondeo.eventos} eventos, ${d.sondeo.conPrecio} con cuotas · ` +
            `mercados: ${d.sondeo.mercados.join(', ') || '—'} · casas (${d.sondeo.casas.length}): ${d.sondeo.casas.slice(0, 8).join(', ') || '—'}`,
        );
      }
    }
    const kinds = new Set(d.ultimas.filter((o) => !o.ok).map((o) => o.kind));
    const accion = [...kinds]
      .filter((k): k is OddsApiFailure => !!k && k !== 'presupuesto')
      .map((k) => ACCION_POR_FALLO[k]);
    if (kinds.has('presupuesto')) accion.push('npm run odds   # a mano se salta el freno de ritmo');
    out.push(h(S, nivel, texto, { detalle, accion: nivel === 'ok' || nivel === 'info' ? undefined : accion.length ? accion : ['npm run odds   # vuelve a descargar y mira el detalle'] }));
  }
  return out;
}

// ===========================================================================
// BASE DE DATOS
// ===========================================================================

export interface ConteoDeporte {
  nombre: string;
  total: number;
  reales: number;
  demo: number;
  sinCuotas: number;
}

export function comprobarBaseDeDatos(ruta: string, existe: boolean, conteos: ConteoDeporte[], hayClave: boolean): Hallazgo[] {
  const S: Seccion = 'BASE DE DATOS';
  if (!existe) {
    return [h(S, 'error', `No existe la base de datos (${ruta})`, { accion: ['npm run fetch-data   # o npm run update-all'] })];
  }
  const out: Hallazgo[] = [h(S, 'ok', `DB accesible (${ruta})`)];
  const t = conteos.reduce((a, c) => ({ total: a.total + c.total, reales: a.reales + c.reales, demo: a.demo + c.demo, sin: a.sin + c.sinCuotas }), { total: 0, reales: 0, demo: 0, sin: 0 });
  out.push(h(S, t.total > 0 ? 'ok' : 'aviso', `${t.total} próximos eventos`));
  out.push(h(S, t.reales > 0 ? 'ok' : hayClave ? 'aviso' : 'info', `${t.reales} con cuotas reales`));
  if (t.demo > 0) {
    out.push(
      h(S, hayClave ? 'aviso' : 'info', `${t.demo} de DEMOSTRACIÓN (cuotas inventadas por la app, marcadas como demo)`, {
        accion: hayClave ? ['npm run odds   # pide las cuotas reales de los siete deportes'] : undefined,
      }),
    );
  }
  // Sin clave, un calendario sin precio es lo esperado (NFL y NHL lo traen sin cuotas): información, no aviso.
  if (t.sin > 0) out.push(h(S, hayClave ? 'aviso' : 'info', `${t.sin} sin cuotas (calendario sin precio publicado)`));
  for (const c of conteos) {
    if (c.total === 0) continue;
    const partes = [`${c.total} próximos`, `${c.reales} con cuotas reales`];
    if (c.demo) partes.push(`${c.demo} demo`);
    if (c.sinCuotas) partes.push(`${c.sinCuotas} sin cuotas`);
    out.push(h(S, 'info', `${c.nombre.padEnd(10)} ${partes.join(' · ')}`));
  }
  return out;
}

// ===========================================================================
// ACTUALIZACIÓN
// ===========================================================================

/** Las cuotas envejecen: pasado este tiempo la pantalla ya avisa de que pueden no valer. */
export const HORAS_PRECIO_VIEJO = 6;

export function comprobarFrescura(
  deportes: { nombre: string; ultimoRefresco: string | null; precioMasNuevo: string | null }[],
  ahora: Date,
  hayClave: boolean,
): Hallazgo[] {
  const S: Seccion = 'ACTUALIZACIÓN';
  const out: Hallazgo[] = [];
  const hace = (iso: string): string => {
    const min = Math.round((ahora.getTime() - Date.parse(iso)) / 60_000);
    if (min < 1) return 'hace menos de un minuto';
    if (min < 120) return `hace ${min} min`;
    if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
    return `hace ${Math.round(min / 1440)} días`;
  };
  const refrescos = deportes.map((d) => d.ultimoRefresco).filter((x): x is string => !!x).sort();
  const ultimo = refrescos.at(-1) ?? null;
  const reales = deportes.map((d) => d.precioMasNuevo).filter((x): x is string => !!x).sort();
  if (!ultimo) {
    out.push(h(S, hayClave ? 'aviso' : 'info', 'Nunca se han actualizado las cuotas', { accion: hayClave ? ['npm run odds'] : undefined }));
  } else if (reales.length === 0) {
    // Un refresco que solo trajo demostración no es «cuotas actualizadas», y un ✓ aquí
    // sería tranquilizador y falso.
    out.push(h(S, hayClave ? 'aviso' : 'info', `Último refresco ${hace(ultimo)}, pero sin ninguna cuota real guardada`));
  } else {
    out.push(h(S, 'ok', `Última actualización: ${hace(ultimo)} · cuota real más nueva: ${hace(reales.at(-1)!)}`));
  }
  for (const d of deportes) {
    if (!d.precioMasNuevo) continue;
    const horas = (ahora.getTime() - Date.parse(d.precioMasNuevo)) / 3_600_000;
    if (horas > HORAS_PRECIO_VIEJO) {
      out.push(
        h(S, 'aviso', `${d.nombre}: las cuotas reales más nuevas son de ${hace(d.precioMasNuevo)} — puede que ya no valgan`, {
          accion: ['npm run odds'],
        }),
      );
    }
  }
  return out;
}

// ===========================================================================
// CONFIANZA — la capa que decide BET / NO BET (trust/, prematch/)
// ===========================================================================

/** Tres ciclos de 15 min sin latido: el servidor no está corriendo el ciclo pre-partido. */
export const CICLO_MAX_MIN = 45;

/** Por debajo de esto no se habla de «la mayoría»: con 3 abstenciones no hay patrón. */
export const MIN_PATRON = 5;

export interface FamiliaContada {
  familia: string;
  tuberia: boolean;
  /** En cuántas abstenciones aparece (una abstención puede tener varios motivos). */
  n: number;
}

export interface EstadoConfianza {
  /** Último ciclo pre-partido completo (meta), o null si nunca corrió. */
  ultimoCiclo: string | null;
  /** Partidos reales con cuota y por empezar: lo que el ciclo debería estar evaluando. */
  conCuotaPorEmpezar: number;
  /** Empezados ANTES del último ciclo con instantáneas y sin final congelada. */
  sinCongelarTrasCiclo: number;
  /** Empezados después del último ciclo, pendientes de congelar en el siguiente. */
  pendientesDeCongelar: number;
  congeladas: number;
  /** Partidos evaluados en las últimas 24 h, por su decisión MÁS RECIENTE (un partido
   *  se reevalúa cada vez que algo cambia; contar filas contaría refrescos, no partidos). */
  evaluaciones24h: { BET: number; 'NO BET': number; 'SIN MERCADO': number };
  /** Motivos de esas NO BET, por familia (trust/decision.ts → FAMILIAS_MOTIVO). */
  motivos24h: FamiliaContada[];
  /** Partidos que el banco descartó por abstención en 7 días (último motivo de cada uno). */
  banco7d: { total: number; familias: FamiliaContada[] };
  alertas24h: { importante: number; aviso: number; info: number };
  /** El texto de la última alerta de deriva de los últimos 7 días, si la hay. */
  deriva7d: string | null;
}

/** Qué hacer cuando una familia «de tubería» domina. */
const ACCION_TUBERIA: Record<string, string[]> = {
  'precio viejo': ['npm run odds', 'npm run dev   (con el servidor arrancado las cuotas se refrescan solas)'],
  'sin evaluación': ['npm run dev   (el ciclo pre-partido evalúa cada 15 min)', 'npm run paper (o una pasada a mano: evalúa y después apuesta)'],
  'evaluación anterior a las cuotas': ['npm run dev   (el ciclo pre-partido evalúa cada 15 min)', 'npm run paper (o una pasada a mano: evalúa y después apuesta)'],
  'evaluación con otra cuota': ['npm run dev   (el ciclo pre-partido evalúa cada 15 min)', 'npm run paper (o una pasada a mano: evalúa y después apuesta)'],
};

export function comprobarConfianza(e: EstadoConfianza, ahora: Date): Hallazgo[] {
  const S: Seccion = 'CONFIANZA';
  const out: Hallazgo[] = [];
  const hace = (iso: string): string => {
    const min = Math.round((ahora.getTime() - Date.parse(iso)) / 60_000);
    if (min < 1) return 'hace menos de un minuto';
    if (min < 120) return `hace ${min} min`;
    if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
    return `hace ${Math.round(min / 1440)} días`;
  };
  const pct = (n: number, d: number) => `${Math.round((n / d) * 100)} %`;

  // 1. El latido del ciclo pre-partido. Sin él no hay instantáneas T-24h/T-6h/T-1h ni
  //    evaluación con las cuotas nuevas, y el banco —que falla cerrado— no apuesta nada.
  const minCiclo = e.ultimoCiclo ? (ahora.getTime() - Date.parse(e.ultimoCiclo)) / 60_000 : null;
  if (e.conCuotaPorEmpezar > 0 && minCiclo === null) {
    out.push(
      h(S, 'aviso', `El ciclo pre-partido nunca ha corrido y hay ${e.conCuotaPorEmpezar} partido(s) con cuota real por empezar`, {
        detalle: ['Sin evaluación de confianza el banco se abstiene de todo: falla cerrado a propósito.'],
        accion: ['npm run dev'],
      }),
    );
  } else if (e.conCuotaPorEmpezar > 0 && minCiclo !== null && minCiclo > CICLO_MAX_MIN) {
    out.push(
      h(S, 'aviso', `Último ciclo pre-partido ${hace(e.ultimoCiclo!)} con ${e.conCuotaPorEmpezar} partido(s) con cuota real por empezar`, {
        detalle: [
          `Corre cada 15 min con el servidor arrancado; más de ${CICLO_MAX_MIN} min sin él es que el servidor está apagado.`,
          'Mientras tanto no se guardan instantáneas T-24h/T-6h/T-1h y lo que cambie no queda registrado.',
        ],
        accion: ['npm run dev'],
      }),
    );
  } else if (e.ultimoCiclo) {
    out.push(
      h(S, e.conCuotaPorEmpezar > 0 ? 'ok' : 'info', `Ciclo pre-partido: último ${hace(e.ultimoCiclo)}` + (e.conCuotaPorEmpezar > 0 ? ` · ${e.conCuotaPorEmpezar} partido(s) con cuota real por empezar` : ' · ningún partido con cuota real por empezar')),
    );
  } else {
    out.push(h(S, 'info', 'El ciclo pre-partido no ha corrido nunca, pero tampoco hay partidos con cuota real que evaluar'));
  }

  // 2. La final congelada. Se congela con la última instantánea ANTERIOR al inicio, así
  //    que congelar tarde no pierde nada; lo que no puede pasar es que un ciclo que ya
  //    corrió deje sin congelar lo que había empezado antes que él.
  if (e.sinCongelarTrasCiclo > 0) {
    out.push(
      h(S, 'error', `${e.sinCongelarTrasCiclo} partido(s) empezados antes del último ciclo siguen sin predicción final congelada`, {
        detalle: ['El ciclo debería haberlos congelado. Alguna fila incumple las restricciones de prematch_final y se descarta en silencio.'],
        accion: ['npm run verify:data'],
      }),
    );
  } else if (e.congeladas > 0 || e.pendientesDeCongelar > 0) {
    out.push(
      h(S, 'ok', `${e.congeladas} predicción(es) final(es) congelada(s)` + (e.pendientesDeCongelar ? ` · ${e.pendientesDeCongelar} empezado(s) se congelarán en el próximo ciclo` : '')),
    );
  }

  // 3. Las decisiones de las últimas 24 h y por qué se abstiene.
  const ev = e.evaluaciones24h;
  const total = ev.BET + ev['NO BET'] + ev['SIN MERCADO'];
  if (total > 0) {
    const detalle = [...e.motivos24h]
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map((m) => `${pct(m.n, Math.max(ev['NO BET'], 1)).padStart(5)} de las NO BET: ${m.familia}${m.tuberia ? '  (operación, no el partido)' : ''}`);
    out.push(h(S, 'info', `Últimas 24 h: ${total} partido(s) evaluado(s) — ahora ${ev.BET} BET · ${ev['NO BET']} NO BET · ${ev['SIN MERCADO']} sin mercado`, { detalle: detalle.length ? detalle : undefined }));
    const tuberia = e.motivos24h.filter((m) => m.tuberia).sort((a, b) => b.n - a.n)[0];
    if (tuberia && ev['NO BET'] >= MIN_PATRON && tuberia.n / ev['NO BET'] >= 0.5) {
      out.push(
        h(S, 'aviso', `El ${pct(tuberia.n, ev['NO BET'])} de las abstenciones son por «${tuberia.familia}»: no habla del partido, sino de algo sin actualizar`, {
          accion: ACCION_TUBERIA[tuberia.familia] ?? ['npm run dev'],
        }),
      );
    }
  }

  // 4. El banco: lo que descartó por abstención. Si la mayoría es de tubería, el banco
  //    no está siendo prudente: está ciego.
  if (e.banco7d.total > 0) {
    const t = e.banco7d.familias.filter((f) => f.tuberia).reduce((a, f) => a + f.n, 0);
    const principal = [...e.banco7d.familias].sort((a, b) => b.n - a.n)[0];
    if (e.banco7d.total >= MIN_PATRON && t / e.banco7d.total >= 0.5) {
      const peor = e.banco7d.familias.filter((f) => f.tuberia).sort((a, b) => b.n - a.n)[0];
      out.push(
        h(S, 'aviso', `El banco descartó ${t} de ${e.banco7d.total} partido(s) en 7 días porque la evaluación no estaba al día (${peor.familia})`, {
          detalle: ['No es prudencia: el banco no tenía una evaluación hecha con las cuotas que iba a apostar.'],
          accion: ACCION_TUBERIA[peor.familia] ?? ['npm run dev'],
        }),
      );
    } else {
      out.push(h(S, 'info', `El banco descartó ${e.banco7d.total} partido(s) por abstención en 7 días · motivo principal: ${principal.familia}`));
    }
  }

  // 5. Alertas internas. La deriva es la única que pide mirar algo fuera de la pantalla.
  const a = e.alertas24h;
  if (a.importante + a.aviso + a.info > 0) {
    out.push(h(S, 'info', `Alertas internas (24 h): ${a.importante} importante(s) · ${a.aviso} aviso(s) · ${a.info} informativa(s)`, { detalle: ['Detalle en la pestaña 📊 Confianza.'] }));
  }
  if (e.deriva7d) {
    out.push(h(S, 'aviso', `Deriva reciente del modelo: ${e.deriva7d}`, { detalle: ['Mientras dure, las apuestas de ese deporte van a la mitad de importe (RECORTES.deriva).'], accion: ['npm run model:report'] }));
  }
  return out;
}

// ===========================================================================
// SEGURIDAD — la puerta, las cabeceras y que no se cuele ningún secreto
// ===========================================================================

export interface EstadoSeguridad {
  produccion: boolean;
  modo: 'auto' | 'on' | 'off';
  authActiva: boolean;
  passwordLongitud: number;
  totp: boolean;
  sesionesActivas: number;
  cabeceras: boolean;
  errorLog: boolean;
  corsOrigenes: string[];
  envIgnorado: boolean | null;
  hookInstalado: boolean | null;
  /** Resultado del escáner propio sobre los ficheros rastreados; null si no se pudo correr. */
  escaner: { ficheros: number; hallazgos: { fichero: string; linea: number; patron: string }[] } | null;
  gitleaks: boolean;
  errores24h: number;
}

export function comprobarSeguridad(e: EstadoSeguridad): Hallazgo[] {
  const S: Seccion = 'SEGURIDAD';
  const out: Hallazgo[] = [];

  // 1. La puerta.
  if (e.authActiva) {
    if (e.passwordLongitud < 8) {
      out.push(h(S, 'error', `APP_PASSWORD tiene ${e.passwordLongitud} caracteres (mínimo 8): el servidor no arrancará`, { accion: ['Pon una frase larga en APP_PASSWORD (.env o fly secrets)'] }));
    } else {
      out.push(h(S, 'ok', `Contraseña activa (modo ${e.modo}) · ${e.passwordLongitud} caracteres · ${e.totp ? 'con segundo factor TOTP' : 'sin segundo factor'} · ${e.sesionesActivas} sesión(es) abierta(s)`));
      if (!e.totp && e.produccion) out.push(h(S, 'info', 'Sin segundo factor. Opcional: npm run totp:secreto y TOTP_SECRET en los secretos.'));
    }
  } else if (e.produccion) {
    out.push(h(S, 'error', 'Autenticación apagada en producción: el servidor no arrancará', { accion: ['Quita APP_AUTH=off y pon APP_PASSWORD'] }));
  } else {
    out.push(h(S, 'info', `Sin contraseña (modo ${e.modo}, no es producción). Para exigirla en tu red local: APP_AUTH=on y APP_PASSWORD en el .env.`));
  }

  // 2. Cabeceras, CORS y registro de errores.
  out.push(e.cabeceras ? h(S, 'ok', 'Cabeceras de seguridad activas (CSP, nosniff, frame-ancestors, referrer, permissions)') : h(S, 'aviso', 'Cabeceras de seguridad apagadas (features.json: seguridad.cabeceras)', { accion: ['Pon "seguridad.cabeceras" en on en config/features.json'] }));
  out.push(h(S, 'info', e.corsOrigenes.length ? `CORS abierto a: ${e.corsOrigenes.join(', ')}` : 'CORS cerrado: ningún origen ajeno puede llamar a la API desde un navegador'));
  out.push(e.errorLog ? h(S, e.errores24h > 0 ? 'aviso' : 'ok', e.errores24h > 0 ? `${e.errores24h} error(es) de servidor en 24 h (error_log)` : 'Sin errores de servidor en 24 h', e.errores24h > 0 ? { detalle: ['Detalle en la pestaña Confianza → Diagnóstico (o SELECT * FROM error_log).'] } : {}) : h(S, 'aviso', 'Registro de errores apagado (features.json: seguridad.errorLog)'));

  // 3. Secretos.
  if (e.envIgnorado === false) out.push(h(S, 'error', 'El .env NO está ignorado por git: se puede subir con tu clave dentro', { accion: ['Añade .env a .gitignore y, si ya se subió, rota la clave'] }));
  else if (e.envIgnorado === true) out.push(h(S, 'ok', '.env ignorado por git'));
  if (e.escaner) {
    if (e.escaner.hallazgos.length === 0) {
      out.push(h(S, 'ok', `Escáner de secretos: ${e.escaner.ficheros} ficheros rastreados, sin secretos${e.gitleaks ? ' · gitleaks instalado' : ''}`));
    } else {
      out.push(
        h(S, 'error', `Escáner de secretos: ${e.escaner.hallazgos.length} posible(s) secreto(s) en ficheros rastreados`, {
          detalle: e.escaner.hallazgos.slice(0, 5).map((x) => `${x.fichero}${x.linea ? `:${x.linea}` : ''} — ${x.patron}`),
          accion: ['node scripts/secret-scan.mjs --tracked   (y si es real: quítalo y ROTA la clave)'],
        }),
      );
    }
  }
  if (e.hookInstalado === false) {
    out.push(h(S, 'aviso', 'El hook de pre-commit (escáner de secretos) no está activado en este clon', { accion: ['git config core.hooksPath .githooks   (npm install lo hace solo)'] }));
  } else if (e.hookInstalado === true) {
    out.push(h(S, 'ok', `Hook de pre-commit activo${e.gitleaks ? ' (gitleaks + escáner propio)' : ' (escáner propio; gitleaks no instalado, opcional)'}`));
  }
  return out;
}

// ===========================================================================
// DATOS Y COPIAS — los dos ficheros, las migraciones, la copia del libro mayor y las ingestas
// ===========================================================================

export interface EjecucionResumen {
  source: string;
  status: 'running' | 'ok' | 'error';
  started_at: string;
  finished_at: string | null;
  rows_added: number | null;
  error: string | null;
}

export interface EstadoAlmacenamiento {
  layout: 'split' | 'single';
  history: { ruta: string; mb: number } | null;
  ledger: { ruta: string; mb: number } | null;
  /** Ficheros `tennis.db.pre-split-*` que quedaron al partir la base. */
  preSplit: string[];
  /** Hay un tennis.db antiguo y aún no hay history.db/ledger.db. */
  legacySinPartir: boolean;
  migracionesFallidas: string[];
  /** La última copia anotada; `existe` dice si el fichero sigue ahí. */
  backup: { cuando: string; fichero: string | null; existe: boolean } | null;
  copiasLocales: number;
  backupHoras: number;
  s3: boolean;
  apuestasRegistradas: number;
  retencion: { cuando: string; borradas: number } | null;
  snapshots: number;
  ejecuciones: EjecucionResumen[];
  /** Ejecuciones que seguían `running` tras horas y se marcaron como muertas. */
  muertas: number;
}

export const BACKUP_AVISO_HORAS = 36;

export function comprobarAlmacenamiento(e: EstadoAlmacenamiento, ahora: Date): Hallazgo[] {
  const S: Seccion = 'DATOS Y COPIAS';
  const out: Hallazgo[] = [];
  const mb = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} MB`;

  // 1. Disposición y ficheros.
  if (e.legacySinPartir) {
    out.push(h(S, 'aviso', 'Hay una base antigua (tennis.db) todavía sin partir en history.db + ledger.db', { accion: ['npm run db:migrate   (no pierde nada: el original queda al lado como tennis.db.pre-split-<fecha>)'] }));
  } else if (e.layout === 'split') {
    out.push(h(S, 'ok', `Dos ficheros: history.db ${e.history ? mb(e.history.mb) : '—'} (historia, reconstruible) · ledger.db ${e.ledger ? mb(e.ledger.mb) : '—'} (apuestas, predicciones registradas, precios: lo tuyo)`));
  } else {
    out.push(h(S, 'info', `Disposición single (DB_LAYOUT=single): todo en un fichero${e.history ? ` de ${mb(e.history.mb)}` : ''}. Sin ledger.db no hay copias del libro mayor por separado.`));
  }
  if (e.preSplit.length) out.push(h(S, 'info', `${e.preSplit.length} fichero(s) pre-split guardados (${e.preSplit.join(', ')}). Cuando te fíes de la base partida, puedes borrarlos.`));
  if (e.migracionesFallidas.length) {
    out.push(h(S, 'error', `Migración fallida: ${e.migracionesFallidas.join(', ')}. El servidor no arranca con una base a medias`, { accion: ['npm run db:migrate -- --reintentar   (tras mirar el error; o restaura la última copia)'] }));
  } else {
    out.push(h(S, 'ok', 'Migraciones al día en los dos ficheros (schema_version)'));
  }

  // 2. La copia del libro mayor.
  if (e.layout === 'split') {
    if (!e.backup) {
      if (e.apuestasRegistradas > 0) {
        out.push(h(S, 'error', `Nunca se ha hecho una copia del libro mayor y hay ${e.apuestasRegistradas} apuesta(s) de papel registradas`, { accion: ['npm run backup   (y deja el servidor en marcha: la hace sola cada BACKUP_HOURS h)'] }));
      } else {
        out.push(h(S, 'aviso', 'Nunca se ha hecho una copia del libro mayor (aún sin apuestas, así que no se ha perdido nada)', { accion: ['npm run backup'] }));
      }
    } else {
      const horas = (ahora.getTime() - Date.parse(e.backup.cuando)) / 3_600_000;
      const cuando = `hace ${horas < 1 ? `${Math.round(horas * 60)} min` : `${horas.toFixed(horas < 10 ? 1 : 0)} h`}`;
      if (horas > BACKUP_AVISO_HORAS) {
        out.push(h(S, 'aviso', `La última copia del libro mayor es de ${cuando} (más de ${BACKUP_AVISO_HORAS} h)`, { accion: ['npm run backup', e.backupHoras > 0 ? `El servidor la hace cada ${e.backupHoras} h si está en marcha (BACKUP_HOURS)` : 'BACKUP_HOURS=0 apaga la programada: ponla en 24'] }));
      } else if (!e.backup.existe) {
        out.push(h(S, 'aviso', `La última copia (${cuando}) ya no está en ${e.backup.fichero ?? 'su sitio'}`, { accion: ['npm run backup'] }));
      } else {
        out.push(h(S, 'ok', `Copia del libro mayor ${cuando} · ${e.copiasLocales} local(es)${e.s3 ? ' · se sube a S3' : ''}${e.backupHoras > 0 ? ` · programada cada ${e.backupHoras} h` : ''}`));
      }
    }
    if (!e.s3) out.push(h(S, 'info', 'Las copias solo están en esta máquina. Para tener una fuera, rellena BACKUP_S3_* (.env.example): AWS, R2, B2 o MinIO.'));
  }

  // 3. Retención de snapshots (manual, nunca automática).
  out.push(
    h(S, 'info', `${e.snapshots.toLocaleString('es')} snapshots de cuotas${e.retencion ? ` · última retención ${e.retencion.cuando.slice(0, 10)} (${e.retencion.borradas} archivadas)` : ' · sin retención aplicada (npm run odds:retention -- --dias 90 enseña el plan)'}`),
  );

  // 4. Ingestas: la última de cada fuente.
  if (e.muertas > 0) out.push(h(S, 'aviso', `${e.muertas} ejecución(es) de ingesta se quedaron a medias (proceso caído) y se han marcado como error`));
  const errores = e.ejecuciones.filter((x) => x.status === 'error');
  const enMarcha = e.ejecuciones.filter((x) => x.status === 'running');
  const ok = e.ejecuciones.filter((x) => x.status === 'ok');
  if (e.ejecuciones.length === 0) {
    out.push(h(S, 'info', 'Sin ejecuciones de ingesta registradas todavía (ingestion_runs se rellena con cada refresco de cuotas y cada update-data)'));
  } else {
    if (ok.length) out.push(h(S, 'ok', `${ok.length} fuente(s) con la última ingesta bien: ${ok.map((x) => `${x.source} (${x.started_at.slice(0, 16).replace('T', ' ')}${x.rows_added != null ? `, ${x.rows_added} filas` : ''})`).join(' · ')}`));
    for (const x of errores) out.push(h(S, 'aviso', `La última ingesta de ${x.source} falló (${x.started_at.slice(0, 16).replace('T', ' ')}): ${x.error ?? 'sin detalle'}`, { accion: [`Vuelve a lanzarla (npm run ${x.source.startsWith('odds') ? 'odds' : x.source}) y mira el error`] }));
    for (const x of enMarcha) out.push(h(S, 'info', `${x.source} en marcha desde ${x.started_at.slice(0, 16).replace('T', ' ')}`));
  }
  return out;
}

// ===========================================================================
// SERVIDOR Y PANTALLA
// ===========================================================================

export interface EstadoServidor {
  puertoApi: number;
  puertoWeb: number | null;
  api: { ok: boolean; error?: string } ;
  web: { ok: boolean; error?: string } | null;
  /** /api/today: cuántos partidos ve la pantalla y cuántos con cuota real. */
  hoy: { partidos: number; conPrecio: number } | null;
}

export function comprobarServidor(e: EstadoServidor): Hallazgo[] {
  const S: Seccion = 'SERVIDOR Y PANTALLA';
  if (!e.api.ok) {
    return [
      h(S, 'aviso', `El backend no responde en http://localhost:${e.puertoApi} (${e.api.error ?? 'sin respuesta'})`, {
        detalle: ['Si no lo has arrancado, es normal. Las comprobaciones de arriba no lo necesitan.'],
        accion: ['npm run dev'],
      }),
    ];
  }
  const out: Hallazgo[] = [h(S, 'ok', `Backend funcionando en http://localhost:${e.puertoApi}`)];
  if (e.hoy) {
    out.push(h(S, e.hoy.partidos > 0 ? 'ok' : 'aviso', `Endpoint interno responde: ${e.hoy.partidos} partidos visibles hoy`));
    out.push(
      h(S, e.hoy.conPrecio > 0 ? 'ok' : 'info', e.hoy.conPrecio > 0 ? `${e.hoy.conPrecio} con cuotas reales en pantalla` : 'Ninguno con cuota real en pantalla', {
        detalle: e.hoy.conPrecio > 0 ? undefined : ['Si arriba hay cuotas reales guardadas y aquí no, reinicia el servidor: el .env solo se lee al arrancar.'],
      }),
    );
  }
  if (e.web) {
    out.push(
      e.web.ok
        ? h(S, 'ok', `Pantalla accesible en http://localhost:${e.puertoWeb}`)
        : h(S, 'aviso', `La pantalla no responde en http://localhost:${e.puertoWeb} (${e.web.error ?? 'sin respuesta'})`, { accion: ['npm run dev'] }),
    );
  }
  return out;
}

// ===========================================================================
// RESULTADO
// ===========================================================================

export function resultado(hs: Hallazgo[]): { nivel: 'ok' | 'aviso' | 'error'; texto: string; acciones: { texto: string; accion: string[] }[] } {
  const errores = hs.filter((x) => x.nivel === 'error');
  const avisos = hs.filter((x) => x.nivel === 'aviso');
  // Una acción que se repite (p. ej. `npm run odds` para tres deportes) se dice UNA vez,
  // con los motivos juntos: una lista de QUÉ HACER con el mismo comando cinco veces
  // parece cinco trabajos y es uno.
  const porAccion = new Map<string, { textos: string[]; accion: string[] }>();
  for (const x of [...errores, ...avisos]) {
    if (!x.accion || x.accion.length === 0) continue;
    const clave = x.accion.join('\n');
    const e = porAccion.get(clave) ?? { textos: [], accion: x.accion };
    e.textos.push(x.texto.replace(/\s+/g, ' ').trim());
    porAccion.set(clave, e);
  }
  const acciones = [...porAccion.values()].map((e) => ({
    texto: e.textos.length === 1 ? e.textos[0] : `${e.textos[0]} (y ${e.textos.length - 1} más: ${e.textos.slice(1).join(' · ')})`,
    accion: e.accion,
  }));
  if (errores.length > 0) {
    return { nivel: 'error', texto: `✗ ${errores.length} error(es) y ${avisos.length} advertencia(s): hay que arreglar algo.`, acciones };
  }
  if (avisos.length > 0) {
    return { nivel: 'aviso', texto: `⚠ Sistema funcional con ${avisos.length} advertencia(s).`, acciones };
  }
  return { nivel: 'ok', texto: '✓ Todo correcto.', acciones };
}

// ---------------------------------------------------------------------------
// ANALÍTICA E INTERFAZ (Fases 4 y 5): lo que tiene estado en la base
// ---------------------------------------------------------------------------
export interface EstadoAnalitica {
  /** Por deporte: predicciones en la ventana actual y si hay deriva. */
  monitorizacion: { deporte: string; n: number; deriva: boolean; motivos: string[] }[];
  /** Último día guardado en monitoring_series, o null si nunca corrió. */
  ultimaSerie: string | null;
  predichasConResultado: number;
  /** Última corrida de simulación (día) y cuántas ligas la tienen. */
  simulacion: { ultimoDia: string | null; ligas: number };
  calendarioPendiente: number;
  fiabilidadBacktest: number;
  anulaciones: string[];
  seguidos: number;
}

export function comprobarAnalitica(e: EstadoAnalitica, ahora: Date): Hallazgo[] {
  const S: Seccion = 'ANALÍTICA E INTERFAZ';
  const out: Hallazgo[] = [];
  const dias = (d: string | null) => (d ? Math.floor((ahora.getTime() - Date.parse(`${d}T00:00:00Z`)) / 86_400_000) : null);
  // Monitorización.
  const conDeriva = e.monitorizacion.filter((m) => m.deriva);
  if (conDeriva.length) {
    for (const m of conDeriva) out.push(h(S, 'aviso', `Deriva en ${m.deporte}: ${m.motivos.join('; ')}`, { accion: ['Revisa Confianza › Analítica del modelo antes de seguir apostando con ese deporte.'] }));
  } else if (e.predichasConResultado > 0 && !e.ultimaSerie) {
    out.push(h(S, 'aviso', 'Hay predicciones en vivo con resultado y la serie de monitorización nunca se ha guardado', { accion: ['Deja el servidor en marcha (trabajo diario «monitorizacion») o: npm run jobs -- ejecutar monitorizacion'] }));
  } else if (e.ultimaSerie) {
    const d = dias(e.ultimaSerie);
    out.push(h(S, d != null && d > 2 ? 'aviso' : 'ok', `Monitorización: serie hasta el ${e.ultimaSerie}${d != null && d > 2 ? ` (hace ${d} días)` : ''}; sin deriva en ningún deporte`));
  } else {
    out.push(h(S, 'info', 'Monitorización: todavía no hay predicciones en vivo con resultado (se necesitan 100 por deporte para concluir nada)'));
  }
  // Fiabilidad del backtest.
  if (e.fiabilidadBacktest === 0) out.push(h(S, 'info', 'Sin diagramas de fiabilidad del backtest (experiments/reliability.json): salen al correr el backtest de referencia de cada deporte'));
  else out.push(h(S, 'ok', `Diagramas de fiabilidad del backtest: ${e.fiabilidadBacktest} deporte(s)`));
  // Simulación.
  if (!e.simulacion.ultimoDia) out.push(h(S, 'info', 'Simulación de temporada: ninguna corrida guardada todavía (trabajo diario «simulacion-temporada»)'));
  else {
    const d = dias(e.simulacion.ultimoDia);
    out.push(h(S, d != null && d > 2 ? 'aviso' : 'ok', `Simulación de temporada: ${e.simulacion.ligas} liga(s), la última del ${e.simulacion.ultimoDia}${d != null && d > 2 ? ` (hace ${d} días: ¿está parado el trabajo?)` : ''}`));
  }
  if (e.calendarioPendiente === 0) out.push(h(S, 'info', 'Calendario pendiente vacío: se llena con la próxima update-data (openfootball, nflverse, MLB). Hasta entonces el fútbol se simula con la doble vuelta reconstruida'));
  else out.push(h(S, 'ok', `Calendario pendiente: ${e.calendarioPendiente.toLocaleString('es')} partidos guardados para simular`));
  // Interfaz.
  if (e.anulaciones.length) out.push(h(S, 'info', `Interruptores anulados desde Ajustes: ${e.anulaciones.join(', ')} (mandan sobre config/features.json)`));
  out.push(h(S, 'info', e.seguidos ? `Seguimiento: ${e.seguidos} equipo(s), jugador(es) o partido(s); las notificaciones de línea movida solo salen para ellos` : 'Seguimiento vacío: con la estrella ☆ en tarjetas y fichas se sigue un equipo, jugador o partido'));
  return out;
}

// ---------------------------------------------------------------------------
// PRODUCTO (Fase 6): laboratorio de estrategias, bandeja, informes, líneas y archivo
// ---------------------------------------------------------------------------
export interface EstadoProducto {
  estrategias: { activas: number; archivadas: number; apuestas: number; pendientes: number; ultimaApuesta: string | null; laboratorio: boolean };
  /** Partidos con cuota guardados para «¿qué habría pasado?», por deporte. */
  historicos: { sport: string; partidos: number; generado: string | null }[];
  hayCuotasReales: boolean;
  bandeja?: { on: boolean; total: number; noLeidas: number };
  /** Último periodo archivado de cada tipo (YYYY-MM-DD / YYYY-Www) y su fecha de creación. */
  informes?: { diarioOn: boolean; semanalOn: boolean; ultimoDiario: { periodo: string; creado: string } | null; ultimoSemanal: { periodo: string; creado: string } | null; total: number; zona: string };
  /** Mercados abiertos con cuotas observadas en 48 h (lo que enseña el comparador). */
  lineas?: { on: boolean; mercados: number };
  archivo?: { on: boolean; predicciones: number };
  /** Las ampliaciones de la Fase 8, todas apagadas por defecto. */
  ampliaciones?: {
    telegram: { on: boolean; token: boolean; chats: number; offset: number | null };
    enVivo: boolean;
    propsNba: boolean;
  };
}

export function comprobarProducto(e: EstadoProducto, ahora: Date): Hallazgo[] {
  const S: Seccion = 'PRODUCTO';
  const out: Hallazgo[] = [];
  const st = e.estrategias;
  if (!st.laboratorio) out.push(h(S, 'info', 'Laboratorio de estrategias apagado (features.json: estrategias.laboratorio)'));
  else if (st.activas + st.archivadas === 0) out.push(h(S, 'info', 'Laboratorio de estrategias: ninguna creada todavía (Apuestas › Laboratorio)'));
  else {
    const dias = st.ultimaApuesta ? Math.floor((ahora.getTime() - Date.parse(st.ultimaApuesta)) / 86_400_000) : null;
    const quieto = st.activas > 0 && e.hayCuotasReales && (dias == null || dias > 7);
    out.push(
      h(
        S,
        quieto ? 'aviso' : 'ok',
        `Laboratorio: ${st.activas} estrategia(s) activa(s) y ${st.archivadas} archivada(s); ${st.apuestas} apuesta(s), ${st.pendientes} pendiente(s)` +
          (st.ultimaApuesta ? `; la última hace ${dias} día(s)` : '; ninguna apuesta todavía'),
        quieto ? { accion: ['Hay cuotas reales y ninguna estrategia ha apostado en una semana: mira los rechazos en `npm run paper` o sube la ventaja mínima esperada.'] } : undefined,
      ),
    );
  }
  const con = e.historicos.filter((x) => x.partidos > 0);
  if (con.length === 0) out.push(h(S, 'info', '«¿Qué habría pasado?» sin histórico: lo escribe la corrida de referencia de los backtests de tenis, fútbol y NFL (experiments/estrategias/)'));
  else out.push(h(S, 'ok', `«¿Qué habría pasado?»: ${con.map((x) => `${x.sport} ${x.partidos.toLocaleString('es')} partidos`).join(' · ')} (sin holdout)`));
  // Bandeja.
  if (e.bandeja) {
    if (!e.bandeja.on) out.push(h(S, 'info', 'Bandeja apagada (features.json: alertas.bandeja): los avisos solo salen por los canales'));
    else out.push(h(S, e.bandeja.noLeidas > 100 ? 'info' : 'ok', `Bandeja: ${e.bandeja.total} aviso(s), ${e.bandeja.noLeidas} sin leer${e.bandeja.noLeidas > 100 ? ' (se acumulan: «Marcar todo como leído» en /bandeja)' : ''}`));
  }
  // Informes.
  if (e.informes) {
    const i = e.informes;
    const hace = (iso: string) => Math.floor((ahora.getTime() - Date.parse(iso)) / 86_400_000);
    if (!i.diarioOn && !i.semanalOn) out.push(h(S, 'info', 'Informes apagados (features.json: informes.diario e informes.semanal)'));
    if (i.diarioOn) {
      if (!i.ultimoDiario) out.push(h(S, 'info', `Resumen diario: ninguno archivado todavía. Lo genera el servidor a partir de las 7:00 (${i.zona}); a mano: npm run jobs -- ejecutar resumen-diario`));
      else {
        const d = hace(i.ultimoDiario.creado);
        out.push(h(S, d > 2 ? 'aviso' : 'ok', `Resumen diario: el último es del ${i.ultimoDiario.periodo}${d > 2 ? ` (hace ${d} días: ¿está parado el trabajo «resumen-diario»?)` : ''}; zona ${i.zona}`));
      }
    }
    if (i.semanalOn) {
      if (!i.ultimoSemanal) out.push(h(S, 'info', 'Informe semanal: ninguno archivado todavía (el lunes a partir de las 7:00; a mano: npm run jobs -- ejecutar informe-semanal)'));
      else {
        const d = hace(i.ultimoSemanal.creado);
        out.push(h(S, d > 14 ? 'aviso' : 'ok', `Informe semanal: el último es la ${i.ultimoSemanal.periodo}${d > 14 ? ` (hace ${d} días)` : ''}; ${i.total} informe(s) en el archivo`));
      }
    }
  }
  if (e.lineas) {
    if (!e.lineas.on) out.push(h(S, 'info', 'Comparador de líneas apagado (features.json: mercado.lineas)'));
    else out.push(h(S, e.lineas.mercados ? 'ok' : 'info', e.lineas.mercados ? `Comparador de líneas: ${e.lineas.mercados} mercado(s) abierto(s) con cuotas de las últimas 48 h` : 'Comparador de líneas vacío: no hay cuotas reales de las últimas 48 h (sin ODDS_API_KEY no hay casas que comparar)'));
  }
  if (e.archivo) {
    if (!e.archivo.on) out.push(h(S, 'info', 'Archivo de predicciones apagado (features.json: archivo.predicciones)'));
    else out.push(h(S, 'info', `Archivo de predicciones: ${e.archivo.predicciones.toLocaleString('es')} predicción(es) registradas en los siete registros`));
  }
  if (e.ampliaciones) out.push(...comprobarAmpliaciones(e.ampliaciones));
  return out;
}

/** Fase 8: asistente por Telegram, tenis punto a punto y props de la NBA. (La NHL y la UFC se publicaron: van con los demás deportes.) */
function comprobarAmpliaciones(a: NonNullable<EstadoProducto['ampliaciones']>): Hallazgo[] {
  const S: Seccion = 'PRODUCTO';
  const out: Hallazgo[] = [];
  const t = a.telegram;
  if (!t.on) out.push(h(S, 'info', 'Asistente por Telegram apagado (features.json: asistente.telegram)'));
  else if (!t.token || t.chats === 0)
    out.push(h(S, 'aviso', `Asistente por Telegram encendido pero ${!t.token ? 'sin TELEGRAM_BOT_TOKEN' : 'sin chats permitidos'}: no contesta a nadie`, { accion: ['Pon TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID (y, si quieres más, TELEGRAM_ASISTENTE_CHATS) en .env'] }));
  else out.push(h(S, 'ok', `Asistente por Telegram: ${t.chats} chat(s) permitido(s); ${t.offset == null ? 'todavía no ha leído ningún mensaje' : `última actualización leída: la ${t.offset - 1}`}`));
  out.push(h(S, 'info', a.enVivo ? 'Tenis en vivo punto a punto encendido: el marcador se teclea a mano (no hay fuente en vivo gratuita y fiable)' : 'Tenis en vivo punto a punto apagado (features.json: tenis.enVivo)'));
  if (a.propsNba) out.push(h(S, 'aviso', 'Props de la NBA encendidos, pero no hay modelo: sin una fuente de box scores legítima y alcanzable el interruptor no hace nada (docs/plans/phase-8.md)'));
  return out;
}

// ---------------------------------------------------------------------------
// OPERACIÓN (Fase 9): trabajos programados, canales de aviso, interruptores, frescura de los
// datos por deporte y, con --fuentes, si cada fuente responde desde esta máquina.
// ---------------------------------------------------------------------------

/** Temporada regular aproximada de cada deporte: [mes, día] de inicio y de fin (puede cruzar el año). */
export const TEMPORADAS: Record<string, { desde: [number, number]; hasta: [number, number]; comando: string }> = {
  Tenis: { desde: [1, 1], hasta: [11, 30], comando: 'npm run update-data' },
  Fútbol: { desde: [8, 10], hasta: [5, 31], comando: 'npm run update-data:fb' },
  Baloncesto: { desde: [10, 20], hasta: [6, 20], comando: 'npm run update-data:bb' },
  Béisbol: { desde: [3, 25], hasta: [10, 31], comando: 'npm run update-data:bsb' },
  NFL: { desde: [9, 5], hasta: [2, 15], comando: 'npm run update-data:naf' },
  // Regular de octubre a mediados de abril, playoffs hasta junio.
  NHL: { desde: [10, 1], hasta: [6, 20], comando: 'npm run update-data:nhl' },
  // Todo el año, una cartelera casi cada semana (la fuente del archivo se actualiza cada semana).
  UFC: { desde: [1, 1], hasta: [12, 31], comando: 'npm run update-data:ufc' },
};
/** Días sin resultados nuevos, en plena temporada, a partir de los que los Elo van atrasados. */
export const DIAS_SIN_RESULTADOS = 21;

const DIA = 86_400_000;

/** Días desde que empezó la temporada en curso, o null si hoy está fuera de temporada. */
export function diasDeTemporada(deporte: string, ahora: Date): number | null {
  const t = TEMPORADAS[deporte];
  if (!t) return null;
  const y = ahora.getUTCFullYear();
  const fecha = (anio: number, [m, d]: [number, number]) => Date.UTC(anio, m - 1, d);
  const cruza = t.hasta[0] < t.desde[0];
  for (const inicioAnio of cruza ? [y, y - 1] : [y]) {
    const ini = fecha(inicioAnio, t.desde);
    const fin = fecha(cruza ? inicioAnio + 1 : inicioAnio, t.hasta) + DIA;
    if (ahora.getTime() >= ini && ahora.getTime() < fin) return Math.floor((ahora.getTime() - ini) / DIA);
  }
  return null;
}

export interface EstadoOperacion {
  /** El registro de trabajos (operacion.registroTrabajos) y lo que dejó escrito en scheduler_jobs. */
  registroOn: boolean;
  trabajos: { nombre: string; enabled: boolean; lastStatus: string | null; lastRunAt: string | null; lastError: string | null; cadenciaMin: number }[];
  canalesOn: boolean;
  canales: { nombre: string; configurado: boolean; falta: string[] }[];
  envios24h: { ok: number; fallidos: number; ultimoError: { canal: string; error: string } | null };
  interruptores: { total: number; encendidos: number; inactivos: { nombre: string; falta: string }[]; huerfanas: string[] };
  /** Último resultado guardado por deporte (YYYY-MM-DD). */
  frescura: { deporte: string; ultimo: string | null; partidos: number }[];
  /** Solo con --fuentes: si cada fuente contesta desde esta máquina. */
  fuentes?: { nombre: string; host: string; ok: boolean; detalle: string }[];
}

export function comprobarOperacion(e: EstadoOperacion, ahora: Date): Hallazgo[] {
  const S: Seccion = 'OPERACIÓN';
  const out: Hallazgo[] = [];
  const hace = (iso: string) => Math.floor((ahora.getTime() - Date.parse(iso)) / DIA);
  const fecha = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

  // Trabajos programados.
  if (!e.registroOn) out.push(h(S, 'info', 'Registro de trabajos apagado (features.json: operacion.registroTrabajos): el servidor no programa nada'));
  else if (e.trabajos.length === 0) out.push(h(S, 'info', 'Trabajos programados: ninguno registrado en esta base todavía (los registra el servidor al arrancar)'));
  else {
    const apagados = e.trabajos.filter((t) => !t.enabled).map((t) => t.nombre);
    const nunca = e.trabajos.filter((t) => t.enabled && !t.lastRunAt).length;
    out.push(
      h(S, 'ok', `Trabajos programados: ${e.trabajos.length} registrados${apagados.length ? `, apagados a mano: ${apagados.join(', ')}` : ''}${nunca ? `; ${nunca} sin ejecutar todavía` : ''}`),
    );
    for (const t of e.trabajos) {
      if (t.lastStatus === 'error')
        out.push(h(S, 'aviso', `Trabajo «${t.nombre}»: falló en su última ejecución (${fecha(t.lastRunAt)}): ${t.lastError ?? 'sin detalle'}`, { accion: [`npm run jobs -- ejecutar ${t.nombre}   # para verlo fallar a mano y con el log completo`] }));
      else if (t.lastStatus === 'running' && t.lastRunAt && ahora.getTime() - Date.parse(t.lastRunAt) > 6 * 3_600_000)
        out.push(h(S, 'aviso', `Trabajo «${t.nombre}»: marcado «en marcha» desde ${fecha(t.lastRunAt)}; el proceso se cayó a medias o sigue colgado`));
    }
  }

  // Canales de aviso.
  if (!e.canalesOn) out.push(h(S, 'info', 'Canales de notificación apagados (features.json: notificaciones.canales): los avisos solo llegan a la bandeja'));
  else {
    const si = e.canales.filter((c) => c.configurado).map((c) => c.nombre);
    const no = e.canales.filter((c) => !c.configurado).map((c) => c.nombre);
    out.push(
      h(S, si.length ? 'ok' : 'info', si.length ? `Canales de notificación: ${si.join(', ')}${no.length ? ` (sin configurar: ${no.join(', ')})` : ''}` : 'Ningún canal de notificación configurado: los avisos solo llegan a la bandeja (variables en .env.example)'),
    );
    if (e.envios24h.fallidos > 0) {
      const u = e.envios24h.ultimoError;
      out.push(h(S, 'aviso', `Notificaciones: ${e.envios24h.fallidos} envío(s) fallido(s) en 24 h (${e.envios24h.ok} bien)${u ? `; el último, por ${u.canal}: ${u.error}` : ''}`, { accion: ['Cuenta › Notificaciones › «probar» en el canal que falla'] }));
    }
  }

  // Interruptores.
  const i = e.interruptores;
  out.push(h(S, 'info', `Interruptores: ${i.encendidos} encendidos de ${i.total} (config/features.json y Ajustes)`));
  if (i.inactivos.length) out.push(h(S, 'info', `Encendidos pero inactivos por falta de una variable: ${i.inactivos.map((x) => `${x.nombre} (${x.falta})`).join(', ')}`));
  if (i.huerfanas.length) out.push(h(S, 'aviso', `Anulaciones de interruptores que ya no existen: ${i.huerfanas.join(', ')}`, { accion: ['Ajustes › Interruptores: quita la anulación (o PATCH /api/features/<nombre> con {"on": null})'] }));

  // Frescura de los resultados.
  for (const f of e.frescura) {
    const dt = diasDeTemporada(f.deporte, ahora);
    const t = TEMPORADAS[f.deporte];
    if (!f.ultimo) {
      out.push(h(S, 'info', `${f.deporte}: ningún resultado en la base${t ? ` (${t.comando})` : ''}`));
      continue;
    }
    const d = hace(f.ultimo);
    if (dt == null) out.push(h(S, 'info', `${f.deporte}: último resultado del ${f.ultimo} (fuera de temporada)`));
    else if (dt > DIAS_SIN_RESULTADOS && d > DIAS_SIN_RESULTADOS)
      out.push(
        h(S, 'aviso', `${f.deporte}: el último resultado es del ${f.ultimo}, hace ${d} días, en plena temporada; sus Elo van atrasados`, t ? { accion: [`${t.comando}   # si la fuente no contesta, docs/FUENTES.md dice cuál es y por qué`] } : undefined),
      );
    else out.push(h(S, 'ok', `${f.deporte}: último resultado del ${f.ultimo}${d > 0 ? ` (hace ${d} día(s))` : ''}`));
  }

  // Fuentes (solo con --fuentes).
  if (e.fuentes) {
    const caidas = e.fuentes.filter((x) => !x.ok);
    if (caidas.length === 0) out.push(h(S, 'ok', `Fuentes: las ${e.fuentes.length} contestan desde esta máquina`));
    for (const x of caidas) out.push(h(S, 'aviso', `Fuente ${x.nombre} (${x.host}): ${x.detalle}`));
  } else out.push(h(S, 'info', 'Para comprobar que cada fuente de datos contesta desde esta máquina: npm run doctor -- --fuentes'));
  return out;
}
