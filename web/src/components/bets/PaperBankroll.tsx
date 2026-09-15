// El banco de papel del modelo, en pantalla.
//
// Va en la pestaña de Apuestas pero SEPARADO del registro de la persona, y eso importa:
// mezclar «lo que apostaste tú» con «lo que apostaría el modelo» en una sola cuenta
// haría imposible responder a ninguna de las dos preguntas.

import { useEffect, useState } from 'react';
import { BREAK_EVEN_COLOR, LOSS_COLOR, PROFIT_COLOR } from '../../lib/theme';

interface Apuesta {
  id: number;
  placed_at: string;
  sport: string;
  label: string;
  selection: string;
  p_model: number;
  p_market: number;
  odds: number;
  stake: number;
  status: string;
  profit: number | null;
}

interface Resumen {
  bancoInicial: number;
  banco: number;
  beneficio: number;
  expuesto: number;
  liquidadas: number;
  ganadas: number;
  perdidas: number;
  pendientes: number;
  roi: number | null;
  arriesgado: number;
  empezado: string | null;
  ultima: { cuando: string; candidatas: number; colocadas: number; rechazos: Record<string, number> } | null;
  apuestas: Apuesta[];
  motivo: string | null;
}

const dinero = (n: number) => `${n >= 0 ? '' : '−'}${Math.abs(n).toFixed(2)} $`;

export default function PaperBankroll() {
  const [r, setR] = useState<Resumen | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    fetch('/api/paper')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((j) => vivo && setR(j as Resumen))
      .catch((e) => vivo && setError((e as Error).message));
    return () => {
      vivo = false;
    };
  }, []);

  if (error) {
    return (
      <section className="mb-6 rounded-xl border border-white/[0.09] bg-white/[0.02] px-4 py-3 text-[14px] text-[#9aa1ac]">
        No he podido leer el banco del modelo ({error}).
      </section>
    );
  }
  if (!r) return null;

  const color = r.beneficio > 0 ? PROFIT_COLOR : r.beneficio < 0 ? LOSS_COLOR : BREAK_EVEN_COLOR;

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <div className="px-4 py-3">
        <h2 className="text-[16px] font-semibold text-[#e8eaed]">El modelo apostando solo</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-[#7b828d]">
          Empieza con {r.bancoInicial} $ y apuesta por su cuenta, con la misma política de
          dimensionamiento que recomienda la app: Kelly a un cuarto, 2 % máximo por evento y
          topes de exposición por día y totales. Esto{' '}
          <strong className="text-[#9aa1ac]">no es dinero real</strong> y no es una recomendación
          — es la única forma de contestar «si le hubiera hecho caso, ¿cuánto habría ganado?».
        </p>
      </div>

      <div className="grid grid-cols-2 gap-px border-t border-white/[0.07] bg-white/[0.05] sm:grid-cols-4">
        {[
          { k: 'Banco', v: dinero(r.banco), c: color },
          { k: 'Beneficio', v: dinero(r.beneficio), c: color },
          // El ROI no existe sin apuestas liquidadas, y enseñar «0 %» se leería como
          // «no gana nada» cuando lo que pasa es que aún no ha jugado.
          { k: 'ROI', v: r.roi === null ? '—' : `${(r.roi * 100).toFixed(1)} %`, c: r.roi === null ? undefined : color },
          { k: 'Comprometido', v: dinero(r.expuesto) },
        ].map((x) => (
          <div key={x.k} className="bg-[#0e0f11] px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-[#7b828d]">{x.k}</div>
            <div className="mt-0.5 text-[18px] font-semibold" style={{ color: x.c ?? '#e8eaed' }}>
              {x.v}
            </div>
          </div>
        ))}
      </div>

      <p className="border-t border-white/[0.07] px-4 py-2.5 text-[13px] text-[#7b828d]">
        {r.liquidadas} liquidada{r.liquidadas === 1 ? '' : 's'} ({r.ganadas} ganada
        {r.ganadas === 1 ? '' : 's'}, {r.perdidas} perdida{r.perdidas === 1 ? '' : 's'}) ·{' '}
        {r.pendientes} sin resolver
        {r.arriesgado > 0 && <> · {dinero(r.arriesgado)} arriesgados en total</>}
        {r.empezado && <> · desde {new Date(r.empezado).toLocaleDateString('es')}</>}
      </p>

      {/* Sin apuestas y con un motivo: se dice el motivo. Un banco a 1.000 y una tabla
          vacía, sin explicación, se lee como que el experimento no funciona. */}
      {r.apuestas.length === 0 && r.motivo && (
        <div className="border-t border-white/[0.07] px-4 py-3 text-[14px] leading-relaxed text-[#9aa1ac]">
          <strong className="text-[#c3c9d1]">Todavía no ha apostado nada.</strong> {r.motivo}
        </div>
      )}

      {/* La última pasada, con los RECHAZOS. Sin esto, un banco quieto se lee igual
          esté esperando partidos, esperando cuotas, o decidiendo no apostar — y la
          tercera es el experimento funcionando, no una avería. */}
      {r.ultima && (r.ultima.candidatas > 0 || Object.keys(r.ultima.rechazos).length > 0) && (
        <div className="border-t border-white/[0.07] px-4 py-2.5 text-[13px] leading-relaxed text-[#7b828d]">
          Última revisión {new Date(r.ultima.cuando).toLocaleString('es', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          })}
          : {r.ultima.candidatas} partido{r.ultima.candidatas === 1 ? '' : 's'} con cuotas reales,{' '}
          {r.ultima.colocadas} apostado{r.ultima.colocadas === 1 ? '' : 's'}.
          {Object.entries(r.ultima.rechazos).map(([motivo, n]) => (
            <span key={motivo} className="block">
              · {n} descartado{n === 1 ? '' : 's'} por {motivo}
            </span>
          ))}
        </div>
      )}

      {r.apuestas.length > 0 && (
        <div className="overflow-x-auto border-t border-white/[0.07]">
          <table className="w-full min-w-[560px] border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#7b828d]">
                <th className="px-4 py-2 font-medium">Partido</th>
                <th className="px-4 py-2 font-medium">Apuesta</th>
                <th className="px-4 py-2 text-right font-medium">Modelo / mercado</th>
                <th className="px-4 py-2 text-right font-medium">Cuota</th>
                <th className="px-4 py-2 text-right font-medium">Importe</th>
                <th className="px-4 py-2 text-right font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {r.apuestas.map((a) => (
                <tr key={a.id} className="border-t border-white/[0.05]">
                  <td className="px-4 py-2.5 text-[#c3c9d1]">{a.label}</td>
                  <td className="px-4 py-2.5 text-[#e8eaed]">{a.selection}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-[#9aa1ac]">
                    {(a.p_model * 100).toFixed(1)} % / {(a.p_market * 100).toFixed(1)} %
                  </td>
                  <td className="px-4 py-2.5 text-right text-[#9aa1ac]">{a.odds.toFixed(2)}</td>
                  <td className="px-4 py-2.5 text-right text-[#9aa1ac]">{a.stake.toFixed(2)}</td>
                  <td
                    className="whitespace-nowrap px-4 py-2.5 text-right font-medium"
                    style={{
                      color:
                        a.status === 'pending'
                          ? '#7b828d'
                          : (a.profit ?? 0) > 0
                            ? PROFIT_COLOR
                            : (a.profit ?? 0) < 0
                              ? LOSS_COLOR
                              : BREAK_EVEN_COLOR,
                    }}
                  >
                    {a.status === 'pending' ? 'pendiente' : dinero(a.profit ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
