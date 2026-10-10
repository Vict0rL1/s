// Un informe archivado (Fase 6.9): el Markdown tal como se escribió y, si está encendido, su PDF.
import { Link, useParams } from 'react-router';
import { useI18n, formato } from '../i18n';
import { useJson } from '../lib/usarJson';
import Markdown from '../components/Markdown';

interface Informe { id: number; tipo: 'diario' | 'semanal'; periodo: string; created_at: string; titulo: string; resumen: string; markdown: string; pdf: boolean }

export default function InformeDetalle() {
  const { id = '' } = useParams();
  const { t, idioma } = useI18n();
  const f = formato(idioma);
  const { datos, error } = useJson<Informe>(`/api/informes/${encodeURIComponent(id)}`);
  return (
    <div className="max-w-3xl">
      <p className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-(--ink-muted)">
        <Link to="/informes" className="underline-offset-2 hover:underline">{t('nav.informes')}</Link>
        {datos && <span>› {datos.periodo}</span>}
        {datos?.pdf && (
          <a href={`/api/informes/${datos.id}/pdf`} className="ml-auto rounded-lg px-3 py-1.5 text-[13px] text-(--ink-body) ring-1 ring-(--line) hover:bg-(--raised)" download={`informe-${datos.tipo}-${datos.periodo}.pdf`}>
            {t('informes.pdf')}
          </a>
        )}
      </p>
      {error && <p role="alert" className="text-[14px] text-(--ink-soft)">{error}</p>}
      {!datos && !error && <p className="text-[13px] text-(--ink-muted)">{t('comun.cargando')}</p>}
      {datos && (
        <article className="rounded-xl border border-(--line) bg-(--surface-card) p-4" data-testid="informe">
          <Markdown texto={datos.markdown} />
          <p className="mt-4 border-t border-(--line) pt-2 text-[12px] text-(--ink-muted)">{t('informes.archivado', { cuando: f.fecha(datos.created_at) })}</p>
        </article>
      )}
    </div>
  );
}
