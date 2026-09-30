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
        accion: [`cp .env.example .env`, `# y escribe tu clave en la línea ODDS_API_KEY=`],
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
        accion: [`nano "${e.envPath}"   # escribe ODDS_API_KEY= delante de la clave`],
      }),
    );
  }

  // La clave que la app VE.
  if (!e.clave.value) {
    out.push(
      h(S, 'error', 'ODDS_API_KEY no encontrada: la app arrancará en modo demostración', {
        accion: [`echo 'ODDS_API_KEY=tu-clave' >> "${e.envPath}"`, '# y reinicia el servidor: npm run dev'],
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
        accion: hayClave ? ['npm run odds   # pide las cuotas reales de los cinco deportes'] : undefined,
      }),
    );
  }
  if (t.sin > 0) out.push(h(S, 'aviso', `${t.sin} sin cuotas (calendario sin precio publicado)`));
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
