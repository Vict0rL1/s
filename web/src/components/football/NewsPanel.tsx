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

const KIND_LABEL: Record<string, string> = {
  lesion: 'lesión',
  sancion: 'sanción',
  enfermedad: 'enfermedad',
  rotacion: 'rotación',
  salida: 'se fue del club',
  regreso: 'vuelve',
  internacional: 'selección',
  'sin-impacto': 'sin impacto',
  'marcado por ti': 'lo marcaste tú',
  'fuera de la alineación publicada': 'fuera del once publicado',
};

const SOURCE_LABEL: Record<string, string> = {
  noticia: 'parte',
  usuario: 'tú',
  alineacion: 'once publicado',
};

const VERDICT: Record<string, { text: string; tone: string }> = {
  'noticia-primero': {
    text: 'la línea se movió DESPUÉS de la noticia — hubo ventana',
    tone: 'text-emerald-300/90',
  },
  'mercado-primero': {
    text: 'la línea ya se había movido ANTES — el mercado lo sabía',
    tone: 'text-amber-300/90',
  },
  'sin-movimiento': { text: 'la línea no se movió', tone: 'text-slate-400' },
  'sin-datos': { text: 'sin histórico de precios todavía', tone: 'text-slate-500' },
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
  if (applied.length === 0 && watching.length === 0) return null;
  const moved = applied.filter((a) => !a.zeroReason);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h4 className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">{name}</h4>
        {combined.players > 0 && Math.abs(combined.net) > 0.001 && (
          <span className="text-[12px] tabular-nums text-slate-300">
            efecto conjunto{' '}
            <span className={combined.net < 0 ? 'text-rose-300/90' : 'text-emerald-300/90'}>
              {combined.net > 0 ? '+' : ''}
              {combined.net.toFixed(2)} goles
            </span>
          </span>
        )}
      </div>

      {moved.length > 0 && (
        <table className="w-full text-[12px] tabular-nums">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500">
              <th className="text-left font-medium">jugador</th>
              <th className="text-left font-medium">motivo</th>
              <th className="text-right font-medium">fuera</th>
              <th className="text-right font-medium">goles</th>
            </tr>
          </thead>
          <tbody>
            {moved.map((a) => (
              <tr key={a.playerId}>
                <td className="py-0.5 text-slate-300">
                  {a.playerName}
                  <span className="ml-1 text-[10px] text-slate-500">{a.position}</span>
                </td>
                <td className="py-0.5 text-slate-400">
                  {KIND_LABEL[a.kind] ?? a.kind}
                  {a.source !== 'noticia' && (
                    <span className="ml-1 text-[10px] text-slate-500">
                      ({SOURCE_LABEL[a.source]})
                    </span>
                  )}
                </td>
                <td className="py-0.5 text-right text-slate-400">
                  {(a.missProbability * 100).toFixed(0)}%
                </td>
                <td className="py-0.5 text-right font-medium text-rose-300/90">
                  {a.net.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {applied.length > moved.length && (
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          {applied.length - moved.length} ausencia(s) sin efecto en el número:{' '}
          {applied.find((a) => a.zeroReason)?.zeroReason}.
        </p>
      )}

      {watching.length > 0 && (
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          <span className="text-slate-400">En observación</span> (dudas por encima del 50 %, no
          mueven la λ):{' '}
          {watching
            .map((w) => `${w.playerName} ${(w.missProbability * 100).toFixed(0)}%`)
            .join(', ')}
          .
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
      <SectionTitle>Noticias que ya están en este número</SectionTitle>
      <p className="mb-3 text-[13px] leading-relaxed text-[#9aa1ac]">
        Estas ausencias entran <span className="text-slate-300">antes</span> de calcular los goles
        esperados, así que el 1X2 de arriba, el over/under y la rejilla ya las llevan dentro. La
        columna de goles es lo que cuesta cada una: sale de la cuota del jugador en su equipo y de
        unos pesos ajustados sobre tres temporadas de alineaciones reales.
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
        <p className="mb-3 text-[12px] leading-relaxed text-slate-500">
          El efecto conjunto no es la suma de las líneas, y no es un redondeo: los pesos se aplican
          sobre la cuota total que falta, así que dos ausencias juntas cuestan algo menos que las
          dos por separado.
        </p>
      )}

      {(n.lineup.home || n.lineup.away) && (
        <div className="mb-3 border-t border-slate-700/50 pt-2">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">
            Alineación confirmada
          </h4>
          {[
            [home, n.lineup.home],
            [away, n.lineup.away],
          ].map(([name, d]) =>
            d && typeof d === 'object' ? (
              <p key={name as string} className="text-[12px] leading-relaxed text-slate-400">
                <span className="text-slate-300">{name as string}</span>: {d.matched} de los
                esperados confirmados.
                {d.unexpectedlyOut.length > 0 && (
                  <>
                    {' '}
                    <span className="text-amber-300/90">
                      Fuera del once sin previo aviso: {d.unexpectedlyOut.map((p) => p.name).join(', ')}
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
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">
            Calendario
          </h4>
          {[
            [home, n.rotation.home],
            [away, n.rotation.away],
          ].map(([name, r]) =>
            r && typeof r === 'object' && r.risk > 0.3 ? (
              <p key={name as string} className="text-[12px] leading-relaxed text-slate-400">
                <span className="text-slate-300">{name as string}</span>: {r.reason}
              </p>
            ) : null,
          )}
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
            Esto <span className="text-slate-400">no</span> mueve la predicción: el efecto del
            calendario sobre el rendimiento se midió en este proyecto y salió cero. Lo que crece con
            la congestión es la duda sobre quién sale de inicio, no la debilidad del equipo.
          </p>
        </div>
      )}

      {n.timing.filter((t) => t.verdict !== 'sin-datos').length > 0 && (
        <div className="border-t border-slate-700/50 pt-2">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">
            La noticia contra el movimiento de la línea
          </h4>
          {n.timing
            .filter((t) => t.verdict !== 'sin-datos')
            .slice(0, 6)
            .map((t) => (
              <p key={t.newsId} className="text-[12px] leading-relaxed text-slate-400">
                <span className="text-slate-300">{t.playerName}</span>:{' '}
                <span className={VERDICT[t.verdict]?.tone}>{VERDICT[t.verdict]?.text}</span>
                {t.minutesToMove != null && ` (${t.minutesToMove} min)`}
              </p>
            ))}
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
            Que el precio se mueva después de una noticia no demuestra que se moviera{' '}
            <span className="text-slate-400">por</span> ella. Lo que sí dice el orden es si llegaste
            antes o después que el mercado — y lo normal es después.
          </p>
        </div>
      )}
    </Panel>
  );
}
