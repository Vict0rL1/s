// i18n (Fase 5.25): español como fuente de verdad, inglés al lado. `t(clave, vars)` sustituye
// {var}; una clave sin traducción cae al español, nunca a la clave. El idioma sale de Ajustes
// (servidor), si no del navegador, y se recuerda localmente.

import { fijarIdiomaFormato, localeFormato } from '../lib/formato';
import { createContext, createElement, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { es, type Clave } from './es';

export type Idioma = 'es' | 'en';
const CLAVE = 'predictor.idioma';

export function idiomaGuardado(): Idioma | null {
  try {
    const v = localStorage.getItem(CLAVE);
    return v === 'en' || v === 'es' ? v : null;
  } catch {
    return null;
  }
}

export function idiomaDelNavegador(): Idioma {
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'es';
}

export type Traducir = (clave: Clave, vars?: Record<string, string | number>) => string;

/** El traductor puro, para lo que no es un componente (lib/format.ts): mismo resultado que `t`. */
export function tr(idioma: Idioma, clave: Clave, vars?: Record<string, string | number>): string {
  return traducir(idioma, clave, vars);
}

/** El locale de `Intl` / `toLocale*` para cada idioma. */
export const localeDe = (idioma: Idioma) => (idioma === 'en' ? 'en-GB' : 'es');

/**
 * El inglés se carga aparte, en su propio fichero: con todo el texto de la interfaz en el
 * catálogo, llevarlo en el paquete principal lo subía de ~350 a ~520 kB para todos, y quien
 * usa la app en español no lo necesita. Hasta que llega, cada clave cae al español.
 */
let ingles: Partial<Record<Clave, string>> | null = null;
let cargandoIngles: Promise<void> | null = null;

export function cargarIngles(): Promise<void> {
  cargandoIngles ??= import('./en').then(
    (m) => {
      ingles = m.en;
    },
    (e: unknown) => {
      // Que un fallo de red no lo deje roto para siempre: el siguiente intento vuelve a pedirlo.
      cargandoIngles = null;
      throw e;
    },
  );
  return cargandoIngles;
}

export const inglesListo = (): boolean => ingles !== null;

// Si la visita va a ser en inglés, se pide ya, en paralelo con el arranque de React.
if (typeof window !== 'undefined' && (idiomaGuardado() ?? idiomaDelNavegador()) === 'en') void cargarIngles().catch(() => undefined);

function traducir(idioma: Idioma, clave: Clave, vars?: Record<string, string | number>): string {
  let s: string = (idioma === 'en' ? ingles?.[clave] : undefined) ?? es[clave];
  if (vars) {
    // Plurales (D14): «{n|punto|puntos}» elige por el valor de n, en vez de «punto(s)».
    s = s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (todo, k: string, uno: string, varios: string) => (k in vars ? (Number(vars[k]) === 1 ? uno : varios) : todo));
    for (const [k, v] of Object.entries(vars)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), () => valor(idioma, v));
  }
  return s;
}

/**
 * Un número con decimales sale con la coma o el punto del idioma y los decimales que trae (a lo
 * sumo 4: lo que pase de ahí es ruido de coma flotante). G5 de la prueba en el navegador: con
 * `String(v)` salía «cuota 2.29» al lado de «41,2 %». Los enteros, tal cual: un año o un id no
 * llevan separador de miles.
 */
function valor(idioma: Idioma, v: string | number): string {
  if (typeof v !== 'number' || !Number.isFinite(v) || Number.isInteger(v)) return String(v);
  const decimales = Math.min(4, String(v).split('.')[1]?.length ?? 0);
  return new Intl.NumberFormat(localeFormato(idioma), { maximumFractionDigits: decimales, useGrouping: false }).format(v).replace('-', '−');
}

const Ctx = createContext<{ idioma: Idioma; setIdioma: (i: Idioma) => void; t: Traducir }>({ idioma: 'es', setIdioma: () => {}, t: (c, v) => traducir('es', c, v) });

export function I18nProvider({ children, inicial }: { children: ReactNode; inicial?: Idioma }) {
  const [idioma, setIdiomaState] = useState<Idioma>(inicial ?? idiomaGuardado() ?? idiomaDelNavegador());
  // Los números (lib/formato.ts) siguen al idioma: se fija al pintar, antes que los hijos.
  fijarIdiomaFormato(idioma);
  const [, setCargado] = useState(0);
  const [fallo, setFallo] = useState(false);
  useEffect(() => {
    document.documentElement.lang = idioma;
  }, [idioma]);
  useEffect(() => {
    if (idioma !== 'en' || inglesListo()) return;
    let vivo = true;
    cargarIngles().then(
      () => vivo && setCargado((n) => n + 1),
      () => vivo && setFallo(true),
    );
    return () => {
      vivo = false;
    };
  }, [idioma]);
  const listo = idioma !== 'en' || inglesListo() || fallo;
  // La primera pintada espera al catálogo (mejor un instante en blanco que la app en el idioma
  // equivocado); un cambio de idioma con la app ya pintada no desmonta nada.
  const pintado = useRef(false);
  if (listo) pintado.current = true;
  const setIdioma = useCallback((i: Idioma) => {
    setIdiomaState(i);
    try {
      localStorage.setItem(CLAVE, i);
    } catch {
      // Vale para esta visita.
    }
  }, []);
  // `listo` en las dependencias: cuando llega el inglés, `t` cambia y todo se vuelve a pintar.
  const t = useCallback<Traducir>((c, v) => traducir(idioma, c, v), [idioma, listo]);
  const valor = useMemo(() => ({ idioma, setIdioma, t }), [idioma, setIdioma, t]);
  return <Ctx.Provider value={valor}>{listo || pintado.current ? children : null}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}

/** Formato de números, fechas y moneda según el idioma (Fase 5.25). */
export function formato(idioma: Idioma) {
  const loc = idioma === 'en' ? 'en-GB' : 'es-ES';
  return {
    numero: (n: number, digitos = 0) => new Intl.NumberFormat(loc, { minimumFractionDigits: digitos, maximumFractionDigits: digitos }).format(n),
    porcentaje: (p: number, digitos = 0) => new Intl.NumberFormat(loc, { style: 'percent', minimumFractionDigits: digitos, maximumFractionDigits: digitos }).format(p),
    moneda: (n: number, moneda = 'EUR') => new Intl.NumberFormat(loc, { style: 'currency', currency: moneda }).format(n),
    fecha: (iso: string, opciones: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) => new Intl.DateTimeFormat(loc, opciones).format(new Date(iso)),
  };
}

/**
 * Una frase traducida con elementos dentro (negritas, enlaces): las marcas `{nombre}` que tengan
 * nodo se sustituyen por él y el resto del texto queda tal cual. Así la frase entera vive en el
 * catálogo, en su orden de cada lengua, y no partida en trozos que no se pueden traducir.
 */
export function conNodos(texto: string, nodos: Record<string, ReactNode>): ReactNode[] {
  return texto.split(/(\{\w+\})/).map((trozo, i) => {
    const m = /^\{(\w+)\}$/.exec(trozo);
    // Sin JSX a propósito: los tests de la web cargan este módulo sin la configuración de JSX.
    return m && m[1] in nodos ? createElement(Fragment, { key: i }, nodos[m[1]]) : trozo;
  });
}

/**
 * Los códigos que manda el servidor (ALTA, BAJO, NO BET, SIN MERCADO…) en el idioma de la pantalla.
 * Un código sin entrada en el catálogo se enseña tal cual: nunca la clave.
 */
export function codigo(t: Traducir, c: string): string {
  const k = `codigo.${c}`;
  return k in es ? t(k as Clave) : c;
}

export type { Clave };
