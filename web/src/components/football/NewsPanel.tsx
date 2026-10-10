/**
 * Las noticias que YA están dentro de este número.
 *
 * ===========================================================================
 * ESTE PANEL NO ES UN PANEL DE NOTICIAS
 * ===========================================================================
 * Lo que enseña no es «lo último sobre el Arsenal». Es el desglose de una λ que ya
 * incorpora estas ausencias: el 1X2 de arriba, el over/under, la rejilla y las props del
 * jugador están calculados CON ellas dentro. Por eso cada línea lleva su coste en goles
 * y no un icono de enfermería — el número es lo que permite comprobar que la capa hace
 * algo, y cuánto.
 *
 * Y cuando una ausencia NO mueve nada, se dice por qué. Un cero sin explicación se lee
 * como «esto da igual», y casi siempre significa otra cosa: que el jugador lleva cero
 * minutos esta temporada y el modelo no puede saber que era titular.
 */
import type {
  FbAbsenceImpact,
  FbCombinedImpact,
  FbPrediction,
} from '../../lib/football';
import { Panel, SectionTitle } from '../ui';
import { conNodos, useI18n, type Clave } from '../../i18n';
import { pct as pctF, num as numF } from '../../lib/formato';

const KIND_LABEL: Record<string, Clave> = {
  lesion: 'np.kind.lesion',
  sancion: 'np.kind.sancion',
  enfermedad: 'np.kind.enfermedad',
  rotacion: 'np.kind.rotacion',
  salida: 'np.kind.salida',
  regreso: 'np.kind.regreso',
  internacional: 'np.kind.internacional',
  'sin-impacto': 'np.kind.sinImpacto',
  'marcado por ti': 'np.kind.marcadoPorTi',
  'fuera de la alineación publicada': 'np.kind.fueraOnce',
};

const SOURCE_LABEL: Record<string, Clave> = {
  noticia: 'np.fuente.noticia',
  usuario: 'np.fuente.usuario',
  alineacion: 'np.fuente.alineacion',
};

const VERDICT: Record<string, { text: Clave; tone: string }> = {
  'noticia-primero': {
    text: 'np.v.noticiaPrimero',
    tone: 'text-emerald-300/90',
  },
  'mercado-primero': {
    text: 'np.v.mercadoPrimero',
    tone: 'text-amber-300/90',
  },
  'sin-movimiento': { text: 'np.v.sinMovimiento', tone: 'text-(--ink-soft)' },
  'sin-datos': { text: 'np.v.sinDatos', tone: 'text-(--ink-muted)' },
};

function Side({
  name,
  applied,
  watching,
  combined,
}: {
  name: string;
  applied: FbAbsenceImpact[];
  watching: FbAbsenceImpact[];
  combined: FbCombinedImpact;
}): React.ReactElement | null {
  const { t } = useI18n();
  if (applied.length === 0 && watching.length === 0) return null;
  const moved = applied.filter((a) => !a.zeroReason);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">{name}</h4>
        {combined.players > 0 && Math.abs(combined.net) > 0.001 && (
          <span className="text-[12px] tabular-nums text-(--ink-body)">
            {conNodos(t('np.efectoConjunto'), {
              v: (
                <span className={combined.net < 0 ? 'text-rose-300/90' : 'text-emerald-300/90'}>
                  {t('np.nGoles', { n: `${combined.net > 0 ? '+' : ''}${numF(combined.net, 2)}` })}
                </span>
              ),
            })}
          </span>
        )}
      </div>

      {moved.length > 0 && (
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-(--ink-muted)">
              <th className="text-left font-medium">{t('tm.jugador')}</th>
              <th className="text-left font-medium">{t('np.motivo')}</th>
              <th className="text-right font-medium">{t('np.fuera')}</th>
              <th className="text-right font-medium">{t('np.golesCol')}</th>
            </tr>
          </thead>
          <tbody>
            {moved.map((a) => (
              <tr key={a.playerId}>
                <td className="py-0.5 text-(--ink-body)">
                  {a.playerName}
                  <span className="ml-1 text-[10px] text-(--ink-muted)">{a.position}</span>
                </td>
                <td className="py-0.5 text-(--ink-soft)">
                  {KIND_LABEL[a.kind] ? t(KIND_LABEL[a.kind]) : a.kind}
                  {a.source !== 'noticia' && (
                    <span className="ml-1 text-[10px] text-(--ink-muted)">
                      ({SOURCE_LABEL[a.source] ? t(SOURCE_LABEL[a.source]) : a.source})
                    </span>
                  )}
                </td>
                <td className="py-0.5 text-right text-(--ink-soft)">
                  {pctF(a.missProbability, 0)}
                </td>
                <td className="py-0.5 text-right font-medium text-rose-300/90">
                  {numF(a.net, 3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {applied.length > moved.length && (
        <p className="mt-1 text-[12px] leading-relaxed text-(--ink-muted)">
          {t('np.sinEfecto', { n: applied.length - moved.length, motivo: applied.find((a) => a.zeroReason)?.zeroReason ?? '' })}
        </p>
      )}

      {watching.length > 0 && (
        <p className="mt-1 text-[12px] leading-relaxed text-(--ink-muted)">
          {conNodos(
            t('np.observacion', {
              lista: watching.map((w) => `${w.playerName} ${pctF(w.missProbability, 0)}`).join(', '),
            }),
            { titulo: <span className="text-(--ink-soft)">{t('np.enObservacion')}</span> },
          )}
        </p>
      )}
    </div>
  );
}

export default function NewsPanel({
  prediction,
}: {
  prediction: FbPrediction;
}): React.ReactElement | null {
  const { t } = useI18n();
  const n = prediction.news;
  if (!n) return null;
  const anything =
    n.applied.home.length > 0 ||
    n.applied.away.length > 0 ||
    n.watching.home.length > 0 ||
    n.watching.away.length > 0 ||
    n.lineup.home ||
    n.lineup.away ||
    (n.rotation.home?.risk ?? 0) > 0.3 ||
    (n.rotation.away?.risk ?? 0) > 0.3;
  if (!anything) return null;

  const home = prediction.teams.home.name;
  const away = prediction.teams.away.name;

  return (
    <Panel>
      <SectionTitle>{t('np.titulo')}</SectionTitle>
      <p className="mb-3 text-[13px] leading-relaxed text-(--ink-soft)">
        {conNodos(t('np.intro'), { antes: <span className="text-(--ink-body)">{t('np.antes')}</span> })}
      </p>

      <Side
        name={home}
        applied={n.applied.home}
        watching={n.watching.home}
        combined={n.combined.home}
      />
      <Side
        name={away}
        applied={n.applied.away}
        watching={n.watching.away}
        combined={n.combined.away}
      />

      {(n.applied.home.length > 1 || n.applied.away.length > 1) && (
        <p className="mb-3 text-[12px] leading-relaxed text-(--ink-muted)">
          {t('np.noSuma')}
        </p>
      )}

      {(n.lineup.home || n.lineup.away) && (
        <div className="mb-3 border-t border-slate-700/50 pt-2">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">
            {t('np.alineacion')}
          </h4>
          {[
            [home, n.lineup.home],
            [away, n.lineup.away],
          ].map(([name, d]) =>
            d && typeof d === 'object' ? (
              <p key={name as string} className="text-[12px] leading-relaxed text-(--ink-soft)">
                {conNodos(t('np.confirmados', { n: d.matched }), { equipo: <span className="text-(--ink-body)">{name as string}</span> })}
                {d.unexpectedlyOut.length > 0 && (
                  <>
                    {' '}
                    <span className="text-amber-300/90">
                      {t('np.fueraSinAviso', { lista: d.unexpectedlyOut.map((p) => p.name).join(', ') })}
                    </span>
                    .
                  </>
                )}
              </p>
            ) : null,
          )}
        </div>
      )}

      {((n.rotation.home?.risk ?? 0) > 0.3 || (n.rotation.away?.risk ?? 0) > 0.3) && (
        <div className="mb-3 border-t border-slate-700/50 pt-2">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">
            {t('np.calendario')}
          </h4>
          {[
            [home, n.rotation.home],
            [away, n.rotation.away],
          ].map(([name, r]) =>
            r && typeof r === 'object' && r.risk > 0.3 ? (
              <p key={name as string} className="text-[12px] leading-relaxed text-(--ink-soft)">
                <span className="text-(--ink-body)">{name as string}</span>: {r.reason}
              </p>
            ) : null,
          )}
          <p className="mt-1 text-[12px] leading-relaxed text-(--ink-muted)">
            {conNodos(t('np.calendarioNota'), { no: <span className="text-(--ink-soft)">{t('np.no')}</span> })}
          </p>
        </div>
      )}

      {n.timing.filter((x) => x.verdict !== 'sin-datos').length > 0 && (
        <div className="border-t border-slate-700/50 pt-2">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-(--ink-soft)">
            {t('np.timing')}
          </h4>
          {n.timing
            .filter((x) => x.verdict !== 'sin-datos')
            .slice(0, 6)
            .map((x) => (
              <p key={x.newsId} className="text-[12px] leading-relaxed text-(--ink-soft)">
                <span className="text-(--ink-body)">{x.playerName}</span>:{' '}
                <span className={VERDICT[x.verdict]?.tone}>{VERDICT[x.verdict] ? t(VERDICT[x.verdict].text) : undefined}</span>
                {x.minutesToMove != null && ` (${x.minutesToMove} min)`}
              </p>
            ))}
          <p className="mt-1 text-[12px] leading-relaxed text-(--ink-muted)">
            {conNodos(t('np.timingNota'), { por: <span className="text-(--ink-soft)">{t('np.por')}</span> })}
          </p>
        </div>
      )}
    </Panel>
  );
}
