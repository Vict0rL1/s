// Qué se juega HOY, en los cinco deportes a la vez.
//
// ===========================================================================
// POR QUÉ VIVE FUERA DE LAS PESTAÑAS
// ===========================================================================
// La app se organiza por deporte y eso es correcto: los modelos son distintos, los
// mercados son distintos, y mezclarlos en una lista haría ilegibles los cinco. Pero
// «¿qué hay hoy?» es una pregunta que no respeta esa división y es la primera que se
// hace cualquiera al abrir la app. Contestarla costaba cinco clics y acordarse de lo que
// decía cada pestaña.
//
// Va arriba del todo, encima del contenido de la pestaña, y SE PLIEGA. Plegado se
// recuerda entre visitas: quien ya sabe lo que hay hoy no quiere volver a verlo cada vez
// que cambia de deporte, y una cabecera que no se puede quitar acaba siendo un peaje.

import { useEffect, useState } from 'react';

interface Partido {
  deporte: string;
  cuando: string;
  partido: string;
  favorito: string | null;
  probabilidad: number | null;
  precioReal: boolean;
  empezado: boolean;
}

const EMOJI: Record<string, string> = {
  'Fútbol': '⚽',
  'Baloncesto': '🏀',
  'Béisbol': '⚾',
  'NFL': '🏈',
  'Tenis': '🎾',
};

const CLAVE = 'predictor.today.open';

export default function TodayPanel() {
  const [datos, setDatos] = useState<{ partidos: Partido[]; nota: string | null } | null>(null);
  const [abierto, setAbierto] = useState(() => {
    // localStorage puede fallar (ventana privada, datos bloqueados) y un panel que no
    // abre por eso sería un fallo tonto. Ante la duda, abierto.
    try {
      return localStorage.getItem(CLAVE) !== '0';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    let vivo = true;
    fetch('/api/today')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => vivo && setDatos(j))
      .catch(() => vivo && setDatos({ partidos: [], nota: null }));
    return () => {
      vivo = false;
    };
  }, []);

  function alternar() {
    const v = !abierto;
    setAbierto(v);
    try {
      localStorage.setItem(CLAVE, v ? '1' : '0');
    } catch {
      // No poder recordar la preferencia no puede impedir aplicarla ahora.
    }
  }

  // Sin partidos no se enseña nada. Un panel que dice «hoy no hay nada» ocupando sitio
  // encima de la pestaña es peor que no estar: la pestaña ya lo explica con su motivo.
  if (!datos || datos.partidos.length === 0) return null;

  const porJugar = datos.partidos.filter((p) => !p.empezado);
  const conPrecio = datos.partidos.filter((p) => p.precioReal).length;

  return (
    <section className="mb-5 overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <button
        onClick={alternar}
        aria-expanded={abierto}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-white/[0.03]"
      >
        <span className="min-w-0">
          <span className="text-[15px] font-semibold text-[#e8eaed]">Hoy</span>{' '}
          <span className="text-[13px] text-[#7b828d]">
            {datos.partidos.length} partido{datos.partidos.length === 1 ? '' : 's'} en los cinco
            deportes
            {porJugar.length < datos.partidos.length && ` · ${porJugar.length} por jugar`}
            {conPrecio > 0 && ` · ${conPrecio} con cuotas reales`}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-[#7b828d]">{abierto ? '▲' : '▼'}</span>
      </button>

      {abierto && (
        <div className="border-t border-white/[0.07]">
          <div className="max-h-[22rem] overflow-y-auto">
            <table className="w-full border-collapse text-[14px]">
              <tbody>
                {datos.partidos.map((p, i) => (
                  <tr
                    key={i}
                    className="border-t border-white/[0.05] first:border-t-0"
                    // Un partido empezado no se esconde —sigue siendo lo de hoy— pero se
                    // atenúa: verlo al mismo nivel que uno por jugar invita a apostarlo.
                    style={p.empezado ? { opacity: 0.45 } : undefined}
                  >
                    <td className="whitespace-nowrap py-2 pl-4 pr-2 text-[#9aa1ac]">
                      {new Date(p.cuando).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="py-2 pr-2" aria-label={p.deporte}>
                      <span title={p.deporte}>{EMOJI[p.deporte] ?? '•'}</span>
                    </td>
                    <td className="py-2 pr-3 text-[#c3c9d1]">{p.partido}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right">
                      {p.favorito && p.probabilidad != null ? (
                        <>
                          <span className="text-[#e8eaed]">{p.favorito}</span>{' '}
                          <span className="font-semibold text-[#e8eaed]">
                            {(p.probabilidad * 100).toFixed(0)}%
                          </span>
                        </>
                      ) : (
                        <span className="text-[#5c636e]">sin predicción</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {datos.nota && (
            <p className="border-t border-white/[0.05] px-4 py-2 text-[12px] text-[#7b828d]">
              {datos.nota}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
