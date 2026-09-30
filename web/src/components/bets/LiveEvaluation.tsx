// Cómo va el modelo EN VIVO, con la capa común de métricas (server/src/evaluation).
//
// El log loss va delante y el acierto al final, a propósito: el acierto no distingue un
// 51 % de un 90 % y el log loss sí. Y ningún número va solo: al lado, el del mercado sobre
// los MISMOS partidos, que es la referencia que decide si el modelo aporta algo. Son solo
// predicciones reales registradas antes de cada partido: ningún backtest entra aquí.

import { useEffect, useState } from 'react';
import { LOSS_COLOR, PROFIT_COLOR } from '../../lib/theme';

interface Informe {
  origen: 'live';
  deporte: string;
  n: number;
  logLoss: number | null;
  brier: number | null;
  accuracy: number | null;
  ece: number | null;
  mercado: { n: number; logLoss: number; brier: number; modeloLogLoss: number } | null;
  logLossUniforme: number | null;
  porVersion?: { version: string | null; n: number; logLoss: number | null; mercado: { n: number; logLoss: number; modeloLogLoss: number } | null }[];
}

interface Prueba {
  pregunta: string;
  n: number;
  veredicto: 'a favor' | 'en contra' | 'no concluyente' | 'muestra insuficiente';
  lectura: string;
}
interface Validacion {
  modeloVsMercado: Record<string, Prueba>;
  clvSenales: Prueba;
  clvApostadas: Prueba;
  clvRechazadas: Prueba;
  retornoBanco: Prueba;
  promesa?: Prueba;
}

interface Tramo {
  etiqueta: string;
  n: number;
  roi: number | null;
  roiPrometido: number | null;
  clvMedio: number | null;
}
interface Rendimiento {
  total: Tramo;
  aciertos: number;
  aciertosEsperados: number | null;
  drawdown: { importe: number; pct: number } | null;
  peorRacha: number;
  porDeporte: Tramo[];
  porCuota: Tramo[];
  porEdge: Tramo[];
  senalesPorEdge: (Prueba & { etiqueta: string })[];
  lecturaEdge: string | null;
}
const COLOR_VEREDICTO: Record<Prueba['veredicto'], string> = {
  'a favor': PROFIT_COLOR,
  'en contra': LOSS_COLOR,
  'no concluyente': '#d9a441',
  'muestra insuficiente': '#7b828d',
};

const NOMBRE: Record<string, string> = { tennis: '🎾 Tenis', football: '⚽ Fútbol', basketball: '🏀 Baloncesto', baseball: '⚾ Béisbol', nfl: '🏈 NFL' };
const f3 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(3).replace('.', ','));
const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(1).replace('.', ',')} %`);
const signo = (x: number | null | undefined) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1).replace('.', ',')} %`);

export default function LiveEvaluation() {
  const [d, setD] = useState<Informe[] | null>(null);
  const [v, setV] = useState<Validacion | null>(null);
  const [rend, setRend] = useState<Rendimiento | null>(null);
  useEffect(() => {
    let vivo = true;
    fetch('/api/evaluation')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: { deportes: Informe[]; validacion?: Validacion; rendimiento?: Rendimiento }) => {
        if (!vivo) return;
        setD(j.deportes);
        setV(j.validacion ?? null);
        setRend(j.rendimiento ?? null);
      })
      .catch(() => vivo && setD([]));
    return () => {
      vivo = false;
    };
  }, []);
  if (!d) return null;
  const hay = d.filter((x) => x.n > 0);

  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-white/[0.09] bg-white/[0.02]">
      <div className="px-4 py-3">
        <h3 className="text-[16px] font-semibold text-[#e8eaed]">El modelo en vivo</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-[#7b828d]">
          Predicciones registradas <strong>antes</strong> de cada partido real, contra lo que pasó. Solo en vivo:
          los backtests van aparte. Manda el <strong>log loss</strong> (más bajo es mejor) comparado con el del
          mercado en los mismos partidos; el acierto se da, pero no distingue un 51 % de un 90 %.
        </p>
      </div>
      {hay.length === 0 ? (
        <p className="border-t border-white/[0.07] px-4 py-3 text-[14px] text-[#9aa1ac]">
          Todavía no hay predicciones en vivo con resultado. Se llenará solo a medida que se jueguen partidos
          con cuotas reales.
        </p>
      ) : (
        <div className="overflow-x-auto border-t border-white/[0.07]">
          <table className="w-full min-w-[620px] border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[#7b828d]">
                <th className="px-4 py-2 font-medium">Deporte</th>
                <th className="px-4 py-2 text-right font-medium">Partidos</th>
                <th className="px-4 py-2 text-right font-medium">Log loss</th>
                <th className="px-4 py-2 text-right font-medium">Mercado</th>
                <th className="px-4 py-2 text-right font-medium">No saber nada</th>
                <th className="px-4 py-2 text-right font-medium">Brier</th>
                <th className="px-4 py-2 text-right font-medium">Calibración</th>
                <th className="px-4 py-2 text-right font-medium">Acierto</th>
              </tr>
            </thead>
            <tbody>
              {hay.map((x) => {
                // Comparado sobre los MISMOS partidos: el del modelo restringido a los que
                // tienen precio, no el global.
                const mejor = x.mercado ? x.mercado.modeloLogLoss < x.mercado.logLoss : null;
                return (
                  <tr key={x.deporte} className="border-t border-white/[0.05]">
                    <td className="px-4 py-2.5 text-[#c3c9d1]">{NOMBRE[x.deporte] ?? x.deporte}</td>
                    <td className="px-4 py-2.5 text-right text-[#9aa1ac]">{x.n}</td>
                    <td className="px-4 py-2.5 text-right font-semibold text-[#e8eaed]">{f3(x.logLoss)}</td>
                    <td className="px-4 py-2.5 text-right text-[#9aa1ac]">
                      {x.mercado ? (
                        <>
                          {f3(x.mercado.logLoss)}
                          <span className="block text-[11px]" style={{ color: mejor ? PROFIT_COLOR : LOSS_COLOR }}>
                            {mejor ? 'el modelo, mejor' : 'el mercado, mejor'} · {x.mercado.n} con precio
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[#5c636e]">{f3(x.logLossUniforme)}</td>
                    <td className="px-4 py-2.5 text-right text-[#9aa1ac]">{f3(x.brier)}</td>
                    <td className="px-4 py-2.5 text-right text-[#9aa1ac]">±{pct(x.ece)}</td>
                    <td className="px-4 py-2.5 text-right text-[#7b828d]">{pct(x.accuracy)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {/* POR VERSIÓN. La fila de arriba junta todas las versiones del modelo; en cuanto
              hay más de una, aquí se ve cada una sobre SUS predicciones, para saber si el
              cambio mejoró o empeoró sin que la vieja tape a la nueva. */}
          {hay.some((x) => (x.porVersion?.length ?? 0) > 1) && (
            <div className="border-t border-white/[0.05] px-4 py-2 text-[12px] text-[#9aa1ac]">
              <p className="mb-1 text-[#7b828d]">Por versión del modelo (cada una sobre sus propias predicciones):</p>
              {hay
                .filter((x) => (x.porVersion?.length ?? 0) > 1)
                .map((x) => (
                  <p key={x.deporte}>
                    {NOMBRE[x.deporte] ?? x.deporte}:{' '}
                    {x.porVersion!.map((v, i) => (
                      <span key={v.version ?? 'sin'}>
                        {i > 0 && ' · '}
                        <code className="text-[#c3c9d1]">{v.version ?? 'sin versión (anteriores)'}</code> {v.n} partidos, log loss{' '}
                        {f3(v.logLoss)}
                        {v.mercado && ` (en sus ${v.mercado.n} con precio: modelo ${f3(v.mercado.modeloLogLoss)}, mercado ${f3(v.mercado.logLoss)})`}
                      </span>
                    ))}
                  </p>
                ))}
            </div>
          )}
          {hay.some((x) => x.n < 200) && (
            <p className="border-t border-white/[0.05] px-4 py-2 text-[12px] text-[#7b828d]">
              Con menos de unos cientos de partidos estas cifras se mueven mucho por azar: son el registro de lo
              que pasa, no todavía una medida del modelo.
            </p>
          )}
        </div>
      )}
      {/* EL DINERO, POR TRAMOS. Lo que el banco prometía (la ventaja con que apostó) al lado
          de lo que dio, y dónde: deporte, cuota y tamaño de la ventaja. */}
      {rend && (rend.total.n > 0 || rend.senalesPorEdge.some((t) => t.n > 0)) && (
        <div className="border-t border-white/[0.07] px-4 py-3">
          <h4 className="text-[14px] font-semibold text-[#c3c9d1]">El dinero, por tramos</h4>
          {rend.total.n > 0 && (
            <>
              <p className="mt-1 text-[13px] leading-relaxed text-[#9aa1ac]">
                {rend.total.n} apuestas ganadas o perdidas · ROI{' '}
                <strong style={{ color: (rend.total.roi ?? 0) >= 0 ? PROFIT_COLOR : LOSS_COLOR }}>{signo(rend.total.roi)}</strong> ·
                el modelo prometía {signo(rend.total.roiPrometido)}
                {rend.aciertosEsperados != null &&
                  ` · ${rend.aciertos} acertadas de ${rend.aciertosEsperados.toFixed(1).replace('.', ',')} esperadas`}
                {rend.drawdown && rend.drawdown.importe > 0 && ` · peor caída desde un máximo −${pct(rend.drawdown.pct)} del banco`}
                {rend.peorRacha > 0 && ` · racha más larga perdiendo: ${rend.peorRacha}`}
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-collapse whitespace-nowrap text-[12px] sm:text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[#7b828d]">
                      <th className="py-1.5 pr-2 sm:pr-3 font-medium">Tramo</th>
                      <th className="py-1.5 pr-2 sm:pr-3 text-right font-medium">N.º</th>
                      <th className="py-1.5 pr-2 sm:pr-3 text-right font-medium">ROI</th>
                      <th className="py-1.5 pr-2 sm:pr-3 text-right font-medium">Prometido</th>
                      <th className="py-1.5 text-right font-medium">CLV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ['Por deporte', rend.porDeporte.map((t) => ({ ...t, etiqueta: NOMBRE[t.etiqueta] ?? t.etiqueta }))],
                        ['Por cuota', rend.porCuota],
                        ['Por ventaja al apostar', rend.porEdge],
                      ] as [string, Tramo[]][]
                    ).map(([grupo, ts]) => [
                      <tr key={grupo}>
                        <td colSpan={5} className="pt-2 text-[11px] uppercase tracking-wide text-[#5c636e]">
                          {grupo}
                        </td>
                      </tr>,
                      ...ts.map((t) => (
                        <tr key={grupo + t.etiqueta} className="border-t border-white/[0.05]">
                          <td className="py-1.5 pr-2 sm:pr-3 text-[#c3c9d1]">{t.etiqueta}</td>
                          <td className="py-1.5 pr-2 sm:pr-3 text-right text-[#9aa1ac]">{t.n}</td>
                          <td className="py-1.5 pr-2 sm:pr-3 text-right" style={{ color: (t.roi ?? 0) >= 0 ? PROFIT_COLOR : LOSS_COLOR }}>
                            {signo(t.roi)}
                          </td>
                          <td className="py-1.5 pr-2 sm:pr-3 text-right text-[#7b828d]">{signo(t.roiPrometido)}</td>
                          <td className="py-1.5 text-right text-[#9aa1ac]">{signo(t.clvMedio)}</td>
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {rend.senalesPorEdge.some((t) => t.n > 0) && (
            <div className="mt-3 text-[13px] leading-relaxed">
              <p className="text-[#9aa1ac]">
                ¿Le gana más al cierre una ventaja grande que una pequeña? (todas las señales, apostadas o no)
              </p>
              <ul className="mt-1 space-y-1">
                {rend.senalesPorEdge
                  .filter((t) => t.n > 0)
                  .map((t) => (
                    <li key={t.etiqueta}>
                      <span className="text-[#c3c9d1]">{t.etiqueta}</span>{' '}
                      <strong style={{ color: COLOR_VEREDICTO[t.veredicto] }}>{t.veredicto}</strong>
                      <span className="text-[#7b828d]"> · {t.lectura}</span>
                    </li>
                  ))}
              </ul>
              {rend.lecturaEdge && <p className="mt-1 text-[#9aa1ac]">{rend.lecturaEdge}</p>}
            </div>
          )}
        </div>
      )}
      {/* ¿ES REAL? Cada cifra con su intervalo. El veredicto no promete más de lo que la
          muestra sostiene: con pocos datos dice cuántos harían falta. */}
      {v && (
        <div className="border-t border-white/[0.07] px-4 py-3">
          <h4 className="text-[14px] font-semibold text-[#c3c9d1]">¿Es real?</h4>
          <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed">
            {[
              ...Object.entries(v.modeloVsMercado)
                .filter(([, p]) => p.n > 0)
                .map(([dep, p]) => ({ ...p, pregunta: `${NOMBRE[dep] ?? dep}: ¿el modelo le gana al mercado?` })),
              { ...v.clvSenales, pregunta: '¿El edge que detecta el modelo le gana al cierre? (todas las señales con ventaja)' },
              { ...v.clvApostadas, pregunta: '¿Las apuestas del banco le ganan al cierre?' },
              { ...v.clvRechazadas, pregunta: '¿Las señales que se rechazaron le ganaban al cierre?' },
              { ...v.retornoBanco, pregunta: '¿El banco de papel gana dinero? (retorno medio por apuesta)' },
              ...(v.promesa
                ? [{ ...v.promesa, pregunta: '¿Las apuestas rinden lo que el modelo prometía? (retorno menos la ventaja con que se apostó)' }]
                : []),
            ].map((p) => (
              <li key={p.pregunta}>
                <span className="text-[#9aa1ac]">{p.pregunta}</span>{' '}
                <strong style={{ color: COLOR_VEREDICTO[p.veredicto] }}>{p.veredicto}</strong>
                <span className="text-[#7b828d]"> · {p.lectura}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
