/**
 * Los mercados de menos liquidez: mitades, córners, tarjetas y props de jugador.
 *
 * ===========================================================================
 * POR QUÉ ESTÁN EN SU PROPIO PANEL Y NO MEZCLADOS CON LOS DEMÁS
 * ===========================================================================
 * Porque no son igual de buenos y presentarlos igual sería mentir por omisión.
 *
 *   · El 1X2 del partido está calibrado dentro de 1,5 pp. Las mitades andan por 2-3 pp,
 *     medido sobre 3.634 partidos que el ajuste no vio. Es mucho mejor que el modelo de
 *     mitades anterior (que llegaba a 8,35 pp y por eso no se publicaba) y sigue siendo
 *     peor que el del partido. Cada mercado lleva su error medido al lado.
 *
 *   · Y varios los cotizan dos o tres casas con un margen del 15 %. Ahí una ventaja
 *     aparente sale más veces del precio malo que del acierto, así que el umbral que hay
 *     que exigirles es mayor — y el panel lo dice en puntos, no en adjetivos.
 *
 * La tentación con estos mercados es la contraria: «aquí las casas se equivocan más».
 * Puede ser verdad y esta app no lo ha medido, así que no lo afirma.
 */
import type { FbPrediction } from '../../lib/football';
import { Panel, SectionTitle } from '../ui';
import { pct } from '../../lib/theme';

const DEPTH_STYLE: Record<string, string> = {
  profundo: 'text-emerald-300/90',
  medio: 'text-sky-300/90',
  fino: 'text-amber-300/90',
  'muy-fino': 'text-rose-300/90',
};

const DEPTH_LABEL: Record<string, string> = {
  profundo: 'muchas casas',
  medio: 'bastantes casas',
  fino: 'pocas casas',
  'muy-fino': 'muy pocas casas',
};

/** «+2,7 pp» significa que en realidad pasa más de lo que dice el número. */
function Calibration({ pp }: { pp: number | undefined }): React.ReactElement | null {
  if (pp === undefined) return null;
  const strong = Math.abs(pp) >= 2;
  return (
    <span className={`ml-1.5 text-[11px] ${strong ? 'text-amber-300/80' : 'text-slate-500'}`}>
      ({pp >= 0 ? '+' : ''}
      {pp.toFixed(1)} pp medido)
    </span>
  );
}

function Row({
  label,
  value,
  calibration,
  sub,
}: {
  label: string;
  value: string;
  calibration?: number;
  sub?: string;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-[13px] text-slate-300">
        {label}
        <Calibration pp={calibration} />
        {sub && <span className="ml-1.5 text-[11px] text-slate-500">{sub}</span>}
      </span>
      <span className="text-[13px] font-medium tabular-nums text-slate-100">{value}</span>
    </div>
  );
}

export default function ThinMarkets({
  prediction,
}: {
  prediction: FbPrediction;
}): React.ReactElement | null {
  const t = prediction.thin;
  if (!t) return null;
  const { halves, corners, cards, players, liquidity } = t;
  const nothing = !halves && !corners && !cards && players.length === 0;
  if (nothing) return null;

  const home = prediction.teams.home.name;
  const away = prediction.teams.away.name;

  return (
    <Panel>
      <SectionTitle right={`${liquidity.length} mercados`}>Mercados de menos liquidez</SectionTitle>
      <p className="mb-3 text-[13px] leading-relaxed text-[#9aa1ac]">
        Estos no están tan bien calibrados como el 1X2 del partido, y varios los cotizan pocas
        casas. El «pp medido» de cada línea es cuánto se desvía de la realidad sobre{' '}
        {halves ? halves.calibrationMatches.toLocaleString('es') : '3.634'} partidos que el modelo
        no vio: un <span className="text-amber-300/90">+2,7 pp</span> quiere decir que en realidad
        pasa más de lo que dice el número.
      </p>

      {halves && (
        <div className="mb-3">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">
            Las dos mitades
          </h4>
          <Row
            label="Descanso: gana el local"
            value={pct(halves.htHome)}
            calibration={halves.calibration['descanso-1']}
          />
          <Row
            label="Descanso: empate"
            value={pct(halves.htDraw)}
            calibration={halves.calibration['descanso-X']}
          />
          <Row
            label="Descanso: gana el visitante"
            value={pct(halves.htAway)}
            calibration={halves.calibration['descanso-2']}
          />
          <Row
            label="Descanso: más de 0,5 goles"
            value={pct(halves.htOver05)}
            calibration={halves.calibration['descanso-over-0.5']}
          />
          <Row
            label="Descanso: más de 1,5 goles"
            value={pct(halves.htOver15)}
            calibration={halves.calibration['descanso-over-1.5']}
          />
          <Row
            label={`${home} gana alguna mitad`}
            value={pct(halves.homeWinsAHalf)}
            calibration={halves.calibration['local-gana-una-mitad']}
          />
          <Row
            label={`${away} gana alguna mitad`}
            value={pct(halves.awayWinsAHalf)}
            calibration={halves.calibration['visitante-gana-una-mitad']}
          />
          <p className="mt-1 text-[12px] text-slate-500">
            Goles esperados: {halves.expected.first.toFixed(2)} en la primera parte y{' '}
            {halves.expected.second.toFixed(2)} en la segunda. No se reparten a la mitad: cada
            parte tiene su propio modelo ajustado.
          </p>
        </div>
      )}

      {(corners || cards) && (
        <div className="mb-3">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">
            Córners y tarjetas
          </h4>
          {[corners, cards].map(
            (c) =>
              c && (
                <div key={c.market} className="mb-1.5">
                  <Row
                    label={c.market === 'corners' ? 'Córners esperados' : 'Tarjetas esperadas'}
                    value={c.total.toFixed(1)}
                    sub={`${c.distribution === 'negbin' ? 'binomial negativa' : 'Poisson'}, var/media ${c.dispersion.toFixed(2)}`}
                  />
                  {c.lines.map((l) => (
                    <Row key={l.line} label={`Más de ${l.line}`} value={pct(l.over)} />
                  ))}
                </div>
              ),
          )}
        </div>
      )}

      {!corners && !cards && (
        <p className="mb-3 text-[12px] leading-relaxed text-slate-500">
          <span className="font-medium text-slate-400">Córners y tarjetas: sin datos.</span> El
          modelo está montado y la ingesta los lee, pero la fuente que los publica
          (football-data.co.uk) no es alcanzable desde donde se generaron estos datos, y las que sí
          lo son solo traen marcadores. Se queda apagado en vez de inventarse una media de liga.
        </p>
      )}

      {players.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">
            Props de jugador
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="text-left font-medium">jugador</th>
                  <th className="text-right font-medium">min.</th>
                  <th className="text-right font-medium">no juega</th>
                  <th className="text-right font-medium">marca</th>
                  <th className="text-right font-medium">gol o asist.</th>
                  <th className="text-right font-medium">tarjeta</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.playerId}>
                    <td className="py-0.5 text-slate-300">
                      {p.name}
                      <span className="ml-1 text-[10px] text-slate-500">{p.position}</span>
                    </td>
                    <td className="py-0.5 text-right text-slate-400">
                      {p.minutes.expected.toFixed(0)}
                    </td>
                    <td className="py-0.5 text-right text-slate-400">
                      {pct(p.minutes.pDidNotPlay)}
                    </td>
                    <td className="py-0.5 text-right text-slate-100">{pct(p.goals.atLeastOne)}</td>
                    <td className="py-0.5 text-right font-medium text-slate-100">
                      {pct(p.goalOrAssist)}
                    </td>
                    <td className="py-0.5 text-right text-slate-400">{pct(p.cards.atLeastOne)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">
            Cada prop es minutos esperados × tasa por minuto, pero integrando la{' '}
            <span className="text-slate-400">distribución</span> de minutos y no su media: la masa
            en «no juega» aporta cero, y aplastarla a un promedio infla todas las probabilidades.
            {players[0] && players[0].teamMatches < 5 && (
              <>
                {' '}
                Con {players[0].teamMatches}{' '}
                {players[0].teamMatches === 1 ? 'partido jugado' : 'partidos jugados'} la
                titularidad todavía no está establecida, así que las tasas vienen casi enteras del
                promedio de la posición — la columna «no juega» es alta para todos a propósito.
              </>
            )}
          </p>
        </div>
      )}

      <div className="mt-3 border-t border-slate-700/50 pt-2">
        <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">
          Cuánta ventaja exigirle a cada uno
        </h4>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5">
          {liquidity.map((l) => (
            <span key={l.key} className="text-[12px] text-slate-400">
              {l.label}{' '}
              <span className={DEPTH_STYLE[l.depth] ?? 'text-slate-400'}>
                {DEPTH_LABEL[l.depth]}
              </span>{' '}
              <span className="tabular-nums text-slate-300">
                ≥{(l.minEdge * 100).toFixed(0)} pp
              </span>
            </span>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">
          El umbral del 1X2 son 4 pp. En un mercado con pocas casas el margen es del 12-18 % en vez
          del 4-5 %, así que exigir dos o tres veces más ventaja es, aproximadamente, exigir la
          misma ventaja neta. Cuántas casas cotizan cada mercado no se consulta: el proveedor lo
          sirve por un endpoint aparte que se cobra por evento, y pedirlo para sesenta partidos
          gastaría tu cuota sin haberlo preguntado.
        </p>
      </div>
    </Panel>
  );
}
