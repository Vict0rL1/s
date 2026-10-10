// La NHL en Diagnóstico: la evaluación del backtest con la que se publicó (sin el holdout), con sus
// referencias. Antes era la NHL en sombra, detrás de `deportes.nhl`; publicada, está siempre.
import { localeDe, useI18n } from '../i18n';
import { useJson } from '../lib/usarJson';
import { pct as pctF, num as numF } from '../lib/formato';

interface Sombra {
  partidos: number;
  puntuados: number;
  holdoutExcluido: number;
  ultimo: string | null;
  modelo: { n: number; logLoss: number | null; brier: number | null; accuracy: number | null; ece: number | null } | null;
  referencias: { nombre: string; logLoss: number | null }[];
  porTemporada: { temporada: number; n: number; logLoss: number | null }[];
  aviso: { nivel: string; texto: string | null };
  nota: string;
  parametros: { k: number; campo: number; golesLiga: number; fuerzaProrroga: number };
}

const f4 = (x: number | null) => (x == null ? '—' : numF(x, 4));
const pct = (x: number | null) => (x == null ? '—' : `${pctF(x, 1)}`);

function Contenido() {
  const { t, idioma } = useI18n();
  const d = useJson<Sombra>('/api/nhl/backtest');
  if (d.error) return <p>{d.error}</p>;
  if (!d.datos) return null;
  const s = d.datos;
  return (
    <>
      <p className="mb-1">{t('diag.nhlIntro')}</p>
      <p className="mb-1">{t('diag.nhlPartidos', { partidos: s.partidos.toLocaleString(localeDe(idioma)), ultimo: s.ultimo ?? '—', puntuados: s.puntuados.toLocaleString(localeDe(idioma)), holdout: s.holdoutExcluido.toLocaleString(localeDe(idioma)) })}</p>
      {s.modelo && (
        <>
          <p>{t('diag.nhlModelo', { ll: f4(s.modelo.logLoss), brier: f4(s.modelo.brier), acierto: pct(s.modelo.accuracy) })}</p>
          <ul className="mb-1 list-disc pl-5">
            {s.referencias.map((r) => (
              <li key={r.nombre}>
                {r.nombre}: log loss {f4(r.logLoss)}
              </li>
            ))}
          </ul>
        </>
      )}
      {s.aviso.texto && <p className="mb-1">{s.aviso.texto}</p>}
      <p className="mb-1">{t('diag.nhlParametros', { k: s.parametros.k, campo: s.parametros.campo, goles: s.parametros.golesLiga.toLocaleString(localeDe(idioma)), prorroga: s.parametros.fuerzaProrroga.toLocaleString(localeDe(idioma)) })}</p>
      <p className="text-(--ink-muted)">{s.nota}</p>
    </>
  );
}

export default function NhlBacktest() {
  const { t } = useI18n();
  return (
    <section className="mb-4 rounded-xl border border-(--line) p-4" data-testid="nhl-backtest">
      <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('diag.nhl')}</h3>
      <div className="text-[13px] leading-relaxed text-(--ink-soft)">
        <Contenido />
      </div>
    </section>
  );
}
