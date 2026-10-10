// ¿Cumple la pantalla esta media query? (D12 de la revisión del 8 de octubre: la píldora de estado
// y la campana se montaban dos veces, una escondida por CSS, y cada una pedía lo suyo y tenía
// su reloj. Ahora se monta una sola, la de la disposición que se ve.)
import { useEffect, useState } from 'react';

export function useMediaQuery(consulta: string): boolean {
  const [cumple, setCumple] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(consulta).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(consulta);
    if (!mq) return;
    const f = () => setCumple(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [consulta]);
  return cumple;
}

/** El punto en el que aparece la barra lateral (`lg:` de Tailwind). */
export const ESCRITORIO = '(min-width: 1024px)';
