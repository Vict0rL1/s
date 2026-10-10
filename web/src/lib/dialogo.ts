// Diálogos (D10 de la revisión del 8 de octubre): lo que no depende de React, para probarlo.

interface Tecla {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
}

/** El selector de un diálogo modal abierto (useDialogo les pone aria-modal). */
export const SELECTOR_MODAL = '[role="dialog"][aria-modal="true"]';

/** ¿Puede un atajo de teclado de la app actuar ahora? No en un campo ni con un diálogo abierto. */
export function atajoPermitido(e: Tecla, doc: { querySelector: (sel: string) => unknown }): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  return doc.querySelector(SELECTOR_MODAL) == null;
}

let bloqueos = 0;
let anterior = '';

/** Bloquea el scroll del fondo; devuelve cómo liberarlo. Varios diálogos a la vez se anidan. */
export function bloquearScroll(body: { style: { overflow: string } }): () => void {
  if (bloqueos === 0) anterior = body.style.overflow;
  bloqueos++;
  body.style.overflow = 'hidden';
  let liberado = false;
  return () => {
    if (liberado) return;
    liberado = true;
    bloqueos--;
    if (bloqueos === 0) body.style.overflow = anterior;
  };
}

/**
 * A dónde mover el foco al pulsar Tab dentro de un diálogo, o null si el navegador ya lo hace
 * bien. Da la vuelta en los extremos y devuelve dentro un foco que se había escapado.
 */
export function siguienteFoco<T>(enfocables: T[], actual: T, atras: boolean): T | null {
  if (enfocables.length === 0) return null;
  const i = enfocables.indexOf(actual);
  if (i === -1) return atras ? enfocables[enfocables.length - 1] : enfocables[0];
  if (!atras && i === enfocables.length - 1) return enfocables[0];
  if (atras && i === 0) return enfocables[enfocables.length - 1];
  return null;
}
