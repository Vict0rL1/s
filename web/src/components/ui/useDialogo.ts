// Un diálogo como debe ser (D10 de la revisión del 8 de octubre): Escape cierra, el foco entra al
// abrir, da la vuelta con Tab sin salir y vuelve al botón que lo abrió al cerrar, y el fondo no
// se desplaza por debajo. Lo que no depende de React está en lib/dialogo.ts, con sus tests.
import { useEffect, useRef, type RefObject } from 'react';
import { bloquearScroll, siguienteFoco } from '../../lib/dialogo';

const ENFOCABLES = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogo(abierto: boolean, cerrar: () => void, ref: RefObject<HTMLElement | null>, { bloquear = true }: { bloquear?: boolean } = {}): void {
  const cerrarRef = useRef(cerrar);
  cerrarRef.current = cerrar;
  useEffect(() => {
    if (!abierto) return;
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const liberar = bloquear ? bloquearScroll(document.body) : () => undefined;
    const raiz = ref.current;
    const enfocables = () => (raiz ? Array.from(raiz.querySelectorAll<HTMLElement>(ENFOCABLES)) : []);
    if (raiz && !raiz.contains(document.activeElement)) {
      const primero = enfocables()[0];
      if (primero) primero.focus();
      else {
        raiz.tabIndex = -1;
        raiz.focus();
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cerrarRef.current();
        return;
      }
      if (e.key === 'Tab' && raiz) {
        const sig = siguienteFoco(enfocables(), document.activeElement as HTMLElement, e.shiftKey);
        if (sig) {
          e.preventDefault();
          sig.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      liberar();
      if (previo && document.contains(previo)) previo.focus();
    };
  }, [abierto, bloquear, ref]);
}
