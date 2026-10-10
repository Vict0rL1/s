// «Mi selección»: probabilidad conjunta con la correlación medida y lo que se puede hacer con ella.
import { useEffect, useState } from 'react';
import { PROFIT_TEXT, LOSS_TEXT } from '../../lib/theme';
import { DeporteIcono, StarIcon, CrossIcon } from '../icons';
import { type Pick, type Combinada, pct, num, clave } from './tipos';
import { useNavigate } from 'react-router';
import { borradorDe, comoIcs, comoTexto, descargar, imagenPng, patasDe, CLAVE_BORRADOR } from './acciones';
import { conNodos, useI18n } from '../../i18n';
import { num as numF } from '../../lib/formato';

function useCombinada(elegidos: Pick[]): Combinada | null {
  const [c, setC] = useState<Combinada | null>(null);
  const firma = elegidos.map((p) => `${clave(p)}|${p.probabilidad}|${p.cuota ?? ''}`).join(';');
  useEffect(() => {
    if (elegidos.length === 0) {
      setC(null);
      return;
    }
    let vivo = true;
    const patas = elegidos.map((p) => ({
      sport: p.sport, matchKey: p.matchKey, liga: p.liga, cuando: p.cuando, seleccion: p.favorito,
      indice: p.opciones.findIndex((o) => o.nombre === p.favorito), resultados: p.opciones.length, p: p.probabilidad, cuota: p.cuota,
    }));
    fetch('/api/picks/parlay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patas }) })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: Combinada) => vivo && setC(j))
      .catch(() => vivo && setC(null));
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firma]);
  return c;
}

export function Seleccion({ elegidos, quitar, vaciar }: { elegidos: Pick[]; quitar: (p: Pick) => void; vaciar: () => void }) {
  const { t, idioma } = useI18n();
  const comb = useCombinada(elegidos);
  if (elegidos.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-(--ink-muted)">
        {conNodos(t('sel.vacia'), { estrella: <StarIcon size={13} className="inline align-[-2px]" /> })}
      </p>
    );
  }
  const producto = elegidos.reduce((a, p) => a * p.probabilidad, 1);
  // Con el servidor: la conjunta descuenta la correlación medida; sin él, el producto.
  const todos = comb ? comb.conjunta : producto;
  const esperados = elegidos.reduce((a, p) => a + p.probabilidad, 0);
  const conCuota = elegidos.every((p) => p.cuota);
  const cuota = conCuota ? elegidos.reduce((a, p) => a * (p.cuota as number), 1) : null;
  const ventaja = cuota && todos > 0 ? todos * cuota - 1 : null;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-(--raised) p-2.5">
          <div className="text-[11px] uppercase tracking-wide text-(--ink-muted)">{t('sel.acertarTodos')}</div>
          <div className="text-[22px] font-semibold tabular-nums text-(--ink-strong)">{pct(todos, todos < 0.1 ? 1 : 0)}</div>
          {comb && comb.conjunta !== comb.independiente && comb.incompatibles.length === 0 && (
            <div className="text-[11px] text-(--ink-muted)">{t('sel.independientes', { p: pct(comb.independiente, comb.independiente < 0.1 ? 1 : 0) })}</div>
          )}
        </div>
        <div className="rounded-lg bg-(--raised) p-2.5">
          <div className="text-[11px] uppercase tracking-wide text-(--ink-muted)">{t('sel.esperados')}</div>
          <div className="text-[22px] font-semibold tabular-nums text-(--ink-strong)">
            {num(esperados, 1)} <span className="text-[13px] font-normal text-(--ink-muted)">{t('sel.deN', { n: elegidos.length })}</span>
          </div>
        </div>
        <div className="col-span-2 rounded-lg bg-(--raised) p-2.5 text-[13px] text-(--ink-body)">
          {cuota ? (
            <>
              {conNodos(t('sel.cuotaCombinada', { justa: todos > 0 ? num(1 / todos) : '—' }), {
                cuota: <span className="font-semibold text-(--ink-strong)">{num(cuota)}</span>,
                v: (
                  <span style={{ color: (ventaja ?? 0) > 0 ? PROFIT_TEXT : LOSS_TEXT }}>
                    {(ventaja ?? 0) >= 0 ? '+' : '−'}
                    {pct(Math.abs(ventaja ?? 0), 1)}
                  </span>
                ),
              })}
            </>
          ) : (
            <>{t('sel.justaCombinada', { j: todos > 0 ? num(1 / todos) : '—' })}</>
          )}
        </div>
      </div>
      <ul className="divide-y divide-(--line) rounded-lg ring-1 ring-(--line)">
        {elegidos.map((p) => (
          <li key={clave(p)} className="flex items-center gap-2 px-2.5 py-2 text-[13px]">
            <DeporteIcono nombre={p.sport} size={15} />
            <span className="min-w-0 flex-1 break-words text-(--ink-body)" title={p.partido}>
              {p.favorito}
            </span>
            <span className="tabular-nums text-(--ink-strong)">{pct(p.probabilidad)}</span>
            <button onClick={() => quitar(p)} aria-label={t('sel.quitar', { nombre: p.favorito })} className="grid h-6 w-6 place-items-center rounded text-(--ink-muted) hover:bg-(--raised) hover:text-(--ink-strong)">
              <CrossIcon size={14} />
            </button>
          </li>
        ))}
      </ul>
      <Acciones elegidos={elegidos} comb={comb} />
      <button onClick={vaciar} className="text-[12px] text-(--ink-muted) underline-offset-2 hover:text-(--ink-body) hover:underline">
        {t('sel.vaciar')}
      </button>
      {comb && comb.incompatibles.length > 0 && (
        <p className="text-[12px] leading-relaxed" style={{ color: LOSS_TEXT }}>
          {comb.incompatibles.join('. ')}.
        </p>
      )}
      {comb && comb.vinculos.length > 0 && comb.incompatibles.length === 0 && (
        <p className="text-[11.5px] leading-relaxed text-(--ink-muted)">
          {t('sel.correlacion', {
            n: comb.vinculos.length,
            lista: `${comb.vinculos
              .slice(0, 2)
              .map((v) => `${v.a} / ${v.b} (ρ ${idioma === 'es' ? numF(v.rho, 3) : numF(v.rho, 3)})`)
              .join('; ')}${comb.vinculos.length > 2 ? '…' : ''}`,
          })}
        </p>
      )}
      <p className="text-[11.5px] leading-relaxed text-(--ink-muted)">
        {comb
          ? comb.etiqueta
          : t('sel.multiplica')}{' '}
        {t('sel.estimaciones')}
      </p>
    </div>
  );
}


/** Las acciones de «Mi selección» (Fase 5.15). */
function Acciones({ elegidos, comb }: { elegidos: Pick[]; comb: Combinada | null }) {
  const { t, idioma } = useI18n();
  const navigate = useNavigate();
  const [aviso, setAviso] = useState<string | null>(null);
  const decir = (m: string) => {
    setAviso(m);
    setTimeout(() => setAviso(null), 2500);
  };
  const boton = 'rounded-lg px-2.5 py-1.5 text-[12.5px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised)';
  const fecha = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <button
          className={`${boton} font-medium text-(--ink-strong)`}
          onClick={() => {
            try {
              localStorage.setItem(CLAVE_BORRADOR, JSON.stringify(borradorDe(elegidos, comb, idioma)));
            } catch {
              // Sin almacenamiento no hay borrador; la página de Apuestas abre el formulario vacío.
            }
            navigate('/apuestas?borrador=1');
          }}
        >
          {t('sel.enviar')}
        </button>
        <button
          className={boton}
          onClick={() =>
            void navigator.clipboard
              .writeText(comoTexto(elegidos, comb, idioma))
              .then(() => decir(t('sel.copiada')))
              .catch(() => decir(t('sel.noCopiar')))
          }
        >
          {t('sel.copiar')}
        </button>
        <button className={boton} onClick={() => descargar(`seleccion-${fecha}.json`, JSON.stringify({ patas: patasDe(elegidos), combinada: comb }, null, 2), 'application/json')}>
          JSON
        </button>
        <button className={boton} onClick={() => descargar(`seleccion-${fecha}.ics`, comoIcs(elegidos, new Date(), idioma), 'text/calendar;charset=utf-8')}>
          {t('sel.calendario')}
        </button>
        <button
          className={boton}
          onClick={() =>
            void imagenPng(elegidos, idioma)
              .then((b) => descargar(`seleccion-${fecha}.png`, b))
              .catch((e: Error) => decir(t('sel.noImagen', { error: e.message })))
          }
        >
          {t('sel.imagen')}
        </button>
      </div>
      {aviso && <p role="status" aria-live="polite" className="mt-1 text-[12px] text-(--ink-soft)">{aviso}</p>}
    </div>
  );
}
