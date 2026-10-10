// La UFC en Diagnóstico: la evaluación con la que se publicó (walk-forward por año, sin el holdout),
// la elección entre los dos candidatos fijados de antemano y la prueba, referencia a referencia, en
// todo lo puntuable y en la validación. Antes era la UFC en sombra, detrás de `deportes.ufc`.
import { localeDe, useI18n, type Clave } from '../i18n';
import { useJson } from '../lib/usarJson';
import { pct as pctF, num as numF } from '../lib/formato';

interface Referencia {
  clave: string;
  nombre: string;
  logLoss: number;
  mean: number;
  lo: number;
  hi: number;
  p: number;
}
interface Tramo {
  n: number;
  modelo: number;
  referencias: Referencia[];
  contraElo: { ll: number; mean: number; lo: number; hi: number; p: number };
}
interface Backtest {
  peleas: number;
  puntuadas: number;
  holdoutExcluido: number;
  sinAtribuir: number;
  sinGanador: number;
  ultimo: string | null;
  modelo: { n: number; logLoss: number | null; brier: number | null; accuracy: number | null; ece: number | null } | null;
  eloSolo: number | null;
  prueba: {
    validacion: number;
    eleccion: { candidato: string; rasgos: string[]; llEntrenamiento: number }[];
    elegido: string;
    todo: Tramo;
    enValidacion: Tramo;
    pasa: boolean;
    mejoraAlElo: boolean;
  } | null;
  pesos: Record<string, number>;
  ajustadaCon: number;
  holdoutDesde: number;
  aviso: { nivel: string; texto: string | null };
  nota: string;
}

const f4 = (x: number | null) => (x == null ? '—' : numF(x, 4));
const pct = (x: number | null) => (x == null ? '—' : `${pctF(x, 1)}`);
const signo = (x: number) => `${x > 0 ? '+' : ''}${numF(x, 4)}`;
const CLAVES_REF = ['moneda', 'experiencia', 'record', 'basico'] as const;
const RASGOS = ['elo', 'record', 'edad', 'alcance', 'experiencia'] as const;

function TablaTramo({ titulo, tramo }: { titulo: string; tramo: Tramo }) {
  const { t } = useI18n();
  const nombre = (r: Referencia) => ((CLAVES_REF as readonly string[]).includes(r.clave) ? t(`diag.ufcRef.${r.clave}` as Clave) : r.nombre);
  const fila = (n: string, ll: number, x: { mean: number; lo: number; hi: number }) => (
    <li key={n}>
      {n}: {f4(ll)} · Δ {signo(x.mean)} [{signo(x.lo)}, {signo(x.hi)}] · {x.hi < 0 ? t('diag.ufcGana') : t('diag.ufcNoGana')}
    </li>
  );
  return (
    <div className="mb-2">
      <p className="font-medium text-(--ink-strong)">{titulo}</p>
      <ul className="list-disc pl-5">
        {tramo.referencias.map((r) => fila(nombre(r), r.logLoss, r))}
        {fila(t('diag.ufcEloSolo'), tramo.contraElo.ll, tramo.contraElo)}
      </ul>
    </div>
  );
}

function Contenido() {
  const { t, idioma } = useI18n();
  const d = useJson<Backtest>('/api/ufc/backtest');
  if (d.error) return <p>{d.error}</p>;
  if (!d.datos) return null;
  const s = d.datos;
  const n = (x: number) => x.toLocaleString(localeDe(idioma));
  const rasgo = (k: string) => ((RASGOS as readonly string[]).includes(k) ? t(`ufcd.rasgo.${k}` as Clave) : k);
  return (
    <>
      <p className="mb-1">{t('diag.ufcIntro')}</p>
      <p className="mb-1">
        {t('diag.ufcPeleas', { peleas: n(s.peleas), ultimo: s.ultimo ?? '—', puntuadas: n(s.puntuadas), holdout: n(s.holdoutExcluido), sinAtribuir: n(s.sinAtribuir), sinGanador: n(s.sinGanador) })}
      </p>
      {s.modelo && <p className="mb-1">{t('diag.ufcModelo', { ll: f4(s.modelo.logLoss), brier: f4(s.modelo.brier), acierto: pct(s.modelo.accuracy), elo: f4(s.eloSolo) })}</p>}
      {s.prueba && (
        <>
          <p className="mb-1">
            {t('diag.ufcEleccion', { elegido: s.prueba.eleccion.find((x) => x.candidato === s.prueba!.elegido)?.rasgos.map(rasgo).join(', ') ?? s.prueba.elegido })}{' '}
            {s.prueba.eleccion.map((x) => `${x.rasgos.map(rasgo).join(' + ')}: ${f4(x.llEntrenamiento)}`).join(' · ')}
          </p>
          <p className="mb-1 font-medium" data-testid="ufc-veredicto">
            {s.prueba.pasa ? t('diag.ufcPasa') : t('diag.ufcNoPasa')}
          </p>
          <TablaTramo titulo={t('diag.ufcTodo', { n: n(s.prueba.todo.n), ll: f4(s.prueba.todo.modelo) })} tramo={s.prueba.todo} />
          <TablaTramo titulo={t('diag.ufcValidacion', { anio: s.prueba.validacion, n: n(s.prueba.enValidacion.n), ll: f4(s.prueba.enValidacion.modelo) })} tramo={s.prueba.enValidacion} />
        </>
      )}
      {s.aviso.texto && <p className="mb-1">{s.aviso.texto}</p>}
      {Object.keys(s.pesos).length > 0 && (
        <p className="mb-1">
          {t('diag.ufcPesos', { n: n(s.ajustadaCon), anio: s.holdoutDesde })}{' '}
          {Object.entries(s.pesos)
            .map(([k, v]) => `${rasgo(k)} ${numF(v, 3)}`)
            .join(' · ')}
        </p>
      )}
      <p className="text-(--ink-muted)">{s.nota}</p>
    </>
  );
}

export default function UfcBacktest() {
  const { t } = useI18n();
  return (
    <section className="mb-4 rounded-xl border border-(--line) p-4" data-testid="ufc-backtest">
      <h3 className="mb-2 text-[15px] font-semibold text-(--ink-strong)">{t('diag.ufc')}</h3>
      <div className="text-[13px] leading-relaxed text-(--ink-soft)">
        <Contenido />
      </div>
    </section>
  );
}
