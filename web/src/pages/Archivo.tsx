// Archivo de predicciones (Fase 6.6): todo lo que dijo el modelo, con el resultado, la confianza de
// entonces, el CLV y la versión de política. Búsqueda y filtros en la URL, para poder compartirlos.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useI18n, formato } from '../i18n';
import { useJson } from '../lib/usarJson';
import { SubNav } from '../components/nav/SubNav';
import { COLOR_BENEFICIO, COLOR_PERDIDA } from '../components/charts';
import { useSubnavConfianza } from './subnav';

interface Fila {
  sport: string; matchKey: string; liga: string | null; cuando: string | null; registrada: string; partido: string; favorito: string; probabilidad: number;
  mercado: number | null; banda: string; resultado: 'acierto' | 'fallo' | 'nulo' | 'pendiente'; marcador: string | null; confianza: 'ALTA' | 'MEDIA' | 'BAJA' | null;
  decision: string | null; clv: number | null; clvDe: 'papel' | 'señal' | null; politica: number | null; version: string | null; url: string;
}
interface Respuesta { filas: Fila[]; total: number; pagina: number; porPagina: number; resumen: { resueltas: number; aciertos: number; pendientes: number; aviso: { nivel: string; texto: string | null } }; ligas: { sport: string; liga: string }[] }

const DEPORTES = ['football', 'basketball', 'baseball', 'nfl', 'nhl', 'ufc', 'tennis'];
const FILTROS = ['q', 'sport', 'liga', 'confianza', 'banda', 'resultado', 'desde', 'hasta'] as const;
const sel = 'min-w-0 rounded-lg bg-(--raised) px-2.5 py-1.5 text-[14px] text-(--ink-body) ring-1 ring-(--line)';

export default function Archivo() {
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const subnav = useSubnavConfianza();
  const [q, setQ] = useSearchParams();
  const [texto, setTexto] = useState(q.get('q') ?? '');
  // El texto se aplica al dejar de escribir; el resto, al momento.
  useEffect(() => {
    if (texto === (q.get('q') ?? '')) return;
    const id = setTimeout(() => cambiar('q', texto), 300);
    return () => clearTimeout(id);
  }, [texto]); // eslint-disable-line react-hooks/exhaustive-deps
  const cambiar = (k: string, v: string) =>
    setQ((prev) => {
      const n = new URLSearchParams(prev);
      if (v) n.set(k, v);
      else n.delete(k);
      if (k !== 'pagina') n.delete('pagina');
      return n;
    }, { replace: true });
  const api = new URLSearchParams();
  for (const k of [...FILTROS, 'pagina'] as const) {
    const v = q.get(k);
    if (v) api.set(k, v);
  }
  const { datos, error } = useJson<Respuesta>(`/api/archivo?${api}`);
  const pagina = Number(q.get('pagina') ?? 1);
  const paginas = datos ? Math.max(1, Math.ceil(datos.total / datos.porPagina)) : 1;
  const colorResultado = (r: Fila['resultado']) => (r === 'acierto' ? COLOR_BENEFICIO : r === 'fallo' ? COLOR_PERDIDA : undefined);
  return (
    <div>
      <SubNav etiqueta={t('nav.subConfianza')} enlaces={subnav} />
      <h2 className="mb-1 text-[20px] font-semibold text-(--ink-strong)">{t('archivo.titulo')}</h2>
      <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-(--ink-soft)">{t('archivo.intro')}</p>
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={t('archivo.buscar')} aria-label={t('archivo.buscar')} className={`${sel} sm:col-span-2`} />
        <select aria-label={t('lab.deporte')} value={q.get('sport') ?? ''} onChange={(e) => cambiar('sport', e.target.value)} className={sel}>
          <option value="">{t('bandeja.todosDeportes')}</option>
          {DEPORTES.map((d) => (
            <option key={d} value={d}>{t(`deporte.${d}` as never)}</option>
          ))}
        </select>
        <select aria-label={t('archivo.liga')} value={q.get('liga') ?? ''} onChange={(e) => cambiar('liga', e.target.value)} className={sel}>
          <option value="">{t('archivo.todasLigas')}</option>
          {(datos?.ligas ?? []).filter((l) => !q.get('sport') || l.sport === q.get('sport')).map((l) => (
            <option key={`${l.sport}|${l.liga}`} value={l.liga}>{l.liga}</option>
          ))}
        </select>
        <select aria-label={t('archivo.confianza')} value={q.get('confianza') ?? ''} onChange={(e) => cambiar('confianza', e.target.value)} className={sel}>
          <option value="">{t('archivo.todaConfianza')}</option>
          {['ALTA', 'MEDIA', 'BAJA'].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          <option value="ninguna">{t('archivo.sinEvaluar')}</option>
        </select>
        <select aria-label={t('archivo.banda')} value={q.get('banda') ?? ''} onChange={(e) => cambiar('banda', e.target.value)} className={sel}>
          <option value="">{t('archivo.todasBandas')}</option>
          {['50–60 %', '60–75 %', '≥ 75 %'].map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <select aria-label={t('archivo.resultado')} value={q.get('resultado') ?? ''} onChange={(e) => cambiar('resultado', e.target.value)} className={sel}>
          <option value="">{t('archivo.todosResultados')}</option>
          {(['acierto', 'fallo', 'nulo', 'pendiente'] as const).map((r) => (
            <option key={r} value={r}>{t(`archivo.r.${r}`)}</option>
          ))}
        </select>
        <span className="flex gap-2">
          <input type="date" aria-label={t('archivo.desde')} value={q.get('desde') ?? ''} onChange={(e) => cambiar('desde', e.target.value)} className={`${sel} flex-1`} />
          <input type="date" aria-label={t('archivo.hasta')} value={q.get('hasta') ?? ''} onChange={(e) => cambiar('hasta', e.target.value)} className={`${sel} flex-1`} />
        </span>
      </div>
      {error && <p role="alert" className="text-[14px] text-(--ink-soft)">{error}</p>}
      {datos && (
        <p className="mb-3 text-[13px] text-(--ink-body)" data-testid="resumen-archivo">
          {t('archivo.resumen', { total: f.numero(datos.total), aciertos: datos.resumen.aciertos, resueltas: datos.resumen.resueltas, pendientes: datos.resumen.pendientes })}
          {datos.resumen.aviso.texto && <span className="block text-[12px] text-(--ink-muted)">{datos.resumen.aviso.texto}</span>}
        </p>
      )}
      {datos && datos.filas.length === 0 && <p className="text-[14px] text-(--ink-muted)">{t('archivo.vacio')}</p>}
      <ul className="space-y-2" data-testid="lista-archivo">
        {(datos?.filas ?? []).map((x) => (
          <li key={`${x.sport}|${x.matchKey}`} className="rounded-xl border border-(--line) p-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <Link to={x.url} className="min-w-0 flex-1 break-words text-[14px] font-semibold text-(--ink-strong) hover:underline">{x.partido}</Link>
              <span className="text-[13px] font-semibold" style={{ color: colorResultado(x.resultado) }}>
                {t(`archivo.r.${x.resultado}`)}{x.marcador ? ` · ${x.marcador}` : ''}
              </span>
            </div>
            <p className="mt-0.5 text-[13px] text-(--ink-body)">
              {t('archivo.dijo', { favorito: x.favorito, p: f.porcentaje(x.probabilidad, 0) })}
              {x.mercado != null && <span className="text-(--ink-muted)"> · {t('archivo.mercado', { p: f.porcentaje(x.mercado, 0) })}</span>}
            </p>
            <p className="mt-0.5 text-[12px] text-(--ink-muted)">
              {t(`deporte.${x.sport}` as never)}{x.liga ? ` · ${x.liga}` : ''} · {x.cuando ? f.fecha(x.cuando) : f.fecha(x.registrada)} · {x.banda}
              {' · '}{x.confianza ? t('archivo.conConfianza', { c: x.confianza }) : t('archivo.sinEvaluar')}
              {x.clv != null && <span style={{ color: x.clv >= 0 ? COLOR_BENEFICIO : COLOR_PERDIDA }}> · CLV {f.porcentaje(x.clv, 1)} ({x.clvDe})</span>}
              {x.politica != null && ` · ${t('archivo.politica', { v: x.politica })}`}
              {x.version && ` · ${x.version}`}
            </p>
          </li>
        ))}
      </ul>
      {datos && paginas > 1 && (
        <nav aria-label={t('archivo.paginas')} className="mt-3 flex items-center gap-2 text-[13px]">
          <button disabled={pagina <= 1} onClick={() => cambiar('pagina', String(pagina - 1))} className="rounded-lg px-3 py-1.5 ring-1 ring-(--line) disabled:opacity-50">‹</button>
          <span className="text-(--ink-muted)">{t('archivo.pagina', { n: pagina, de: paginas })}</span>
          <button disabled={pagina >= paginas} onClick={() => cambiar('pagina', String(pagina + 1))} className="rounded-lg px-3 py-1.5 ring-1 ring-(--line) disabled:opacity-50">›</button>
        </nav>
      )}
    </div>
  );
}
