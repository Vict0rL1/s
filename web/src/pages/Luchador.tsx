// La ficha de un luchador de la UFC: Elo y puesto, récord en la UFC, la ficha (edad, alcance, altura,
// guardia), la historia de su Elo, sus últimas diez peleas y las que tiene por delante. Es una URL: se
// puede compartir.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { LineChart } from '../components/charts';
import { RUTA_DE_PESTANA, rutaLuchador, rutaPartido } from '../rutas';
import { aComun, nombrePartido, URL_PROXIMOS, type PartidoComun } from '../lib/partidos';
import type { UfcFighterInfo } from '../lib/ufc';
import { useI18n, formato, type Clave } from '../i18n';

interface Historia { puntos: { fecha: string; elo: number; rival: string; local: boolean }[]; nota: string }

const RESULTADO: Record<UfcFighterInfo['form'][number]['result'], Clave> = { W: 'luchador.r.W', L: 'luchador.r.L', D: 'luchador.r.D', NC: 'luchador.r.NC' };

export default function Luchador() {
  const { id = '' } = useParams();
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const [info, setInfo] = useState<UfcFighterInfo | null | 'error'>(null);
  const [hist, setHist] = useState<Historia | null>(null);
  const [proximas, setProximas] = useState<PartidoComun[]>([]);
  useEffect(() => {
    let vivo = true;
    setInfo(null);
    fetch(`/api/ufc/fighters/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: UfcFighterInfo) => vivo && setInfo(j))
      .catch(() => vivo && setInfo('error'));
    fetch(`/api/elo/historia/ufc/ufc/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).then((j) => vivo && setHist(j)).catch(() => undefined);
    fetch(URL_PROXIMOS.ufc('ufc'))
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Record<string, unknown>[]) => {
        if (!vivo) return;
        setProximas(rows.map((r) => aComun('ufc', r)).filter((p): p is PartidoComun => !!p && (p.casaId === id || p.fueraId === id)).slice(0, 6));
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [id]);
  const serie = hist?.puntos.map((p) => ({ x: Date.parse(p.fecha), y: p.elo })) ?? [];
  const nombre = info && info !== 'error' ? info.name : id;
  const cm = (v: number | null) => (v != null ? `${f.numero(v, 0)} cm` : '—');
  return (
    <div>
      <p className="mb-1 text-[12px] text-(--ink-muted)">
        <Link to={RUTA_DE_PESTANA.ufc} className="underline-offset-2 hover:underline">UFC</Link> › {t('luchador.titulo')}
      </p>
      <div className="mb-4">
        <h2 className="break-words text-[20px] font-semibold text-(--ink-strong)">{nombre}</h2>
        {info && info !== 'error' && (
          <p className="text-[13px] text-(--ink-soft)">
            {info.nickname && <span className="mr-1">«{info.nickname}» ·</span>}
            {t('luchador.resumen', { elo: Math.round(info.elo), peleas: info.fightsInDb })}
            {info.eloRank != null ? ` · ${t('luchador.puesto', { n: info.eloRank })}` : ` · ${t('luchador.inactivo')}`}
          </p>
        )}
      </div>
      {info === 'error' && <p className="text-[14px] text-(--ink-soft)">{t('luchador.noExiste')}</p>}
      {info === null && <p className="text-[13px] text-(--ink-muted)">{t('comun.cargando')}</p>}
      {info && info !== 'error' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('luchador.ficha')}</h3>
            <dl className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-3">
              <div><dt className="text-(--ink-muted)">{t('luchador.record')}</dt><dd className="tabular-nums text-(--ink-strong)">{`${info.record.wins}-${info.record.losses}-${info.record.draws}`}{info.record.noContests ? ` (${info.record.noContests} NC)` : ''}</dd></div>
              <div><dt className="text-(--ink-muted)">{t('ufcd.edad')}</dt><dd className="tabular-nums text-(--ink-strong)">{info.age != null ? f.numero(info.age, 1) : '—'}</dd></div>
              <div><dt className="text-(--ink-muted)">{t('ufcd.alcance')}</dt><dd className="tabular-nums text-(--ink-strong)">{cm(info.reachCm)}</dd></div>
              <div><dt className="text-(--ink-muted)">{t('ufcd.altura')}</dt><dd className="tabular-nums text-(--ink-strong)">{cm(info.heightCm)}</dd></div>
              <div><dt className="text-(--ink-muted)">{t('ufcd.guardia')}</dt><dd className="text-(--ink-strong)">{info.stance ?? '—'}</dd></div>
              <div><dt className="text-(--ink-muted)">{t('ufcd.categoria')}</dt><dd className="text-(--ink-strong)">{info.weightClass ?? '—'}</dd></div>
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-(--ink-faint)">{t('luchador.soloUfc')}</p>
          </section>
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('equipo.historiaElo')}</h3>
            {serie.length > 1 ? <LineChart series={[{ nombre: 'Elo', puntos: serie }]} formatoX={(x) => f.fecha(new Date(x).toISOString(), { month: 'short', year: '2-digit' })} /> : <p className="text-[13px] text-(--ink-muted)">{t('equipo.sinHistoria')}</p>}
            {hist && <p className="mt-1 text-[11px] text-(--ink-faint)">{hist.nota}</p>}
          </section>
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('luchador.ultimas')}</h3>
            {info.form.length === 0 ? (
              <p className="text-[13px] text-(--ink-muted)">{t('luchador.sinPeleas')}</p>
            ) : (
              <ul className="space-y-1 text-[13px]">
                {info.form.map((x) => (
                  <li key={`${x.date}-${x.opponentName}`} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="min-w-0 break-words text-(--ink-body)">
                      <span className="mr-2 font-semibold" style={{ color: x.result === 'W' ? 'var(--profit-text)' : x.result === 'L' ? 'var(--loss-text)' : 'var(--ink-soft)' }}>{t(RESULTADO[x.result])}</span>
                      {x.opponentId ? (
                        <Link to={rutaLuchador(x.opponentId)} className="underline-offset-2 hover:underline">{x.opponentName}</Link>
                      ) : (
                        x.opponentName
                      )}
                      {x.method && <span className="text-(--ink-muted)"> · {x.method}{x.round ? ` (${t('luchador.asalto', { n: x.round })})` : ''}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums text-(--ink-muted)">{x.date}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-xl border border-(--line) p-4">
            <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('luchador.proximas')}</h3>
            {proximas.length === 0 ? (
              <p className="text-[13px] text-(--ink-muted)">{t('luchador.sinProximas')}</p>
            ) : (
              <ul className="space-y-1 text-[13px]">
                {proximas.map((p) => {
                  const esA = p.casaId === id;
                  const prob = p.probs ? (esA ? p.probs[0] : p.probs[1]) : null;
                  return (
                    <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <Link to={rutaPartido('ufc', p.id)} className="min-w-0 break-words text-(--ink-body) underline-offset-2 hover:underline">{nombrePartido(p)}</Link>
                      <span className="shrink-0 tabular-nums text-(--ink-soft)">{prob != null ? f.porcentaje(prob, 1) : '—'}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
