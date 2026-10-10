// Lo que recoge un fallo al pintar una pantalla (D7 de la revisión del 8 de octubre).
//
// Antes no había ninguno: si una pantalla diferida no cargaba (tras un despliegue, su trozo con
// el hash viejo ya no existe), React desmontaba la app entera y quedaba una página en blanco.
// Ahora un error de carga de trozo recarga UNA vez (la página nueva trae los nombres nuevos) y
// cualquier otro error, o uno que persiste, enseña un aviso con un botón para recargar.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { debeRecargar, esErrorDeChunk, MARCA_RECARGA } from '../lib/errores';

function FalloPantalla() {
  const { t } = useI18n();
  return (
    <div role="alert" className="rounded-xl border border-(--line) p-4 text-[14px] text-(--ink-body)">
      <p className="mb-3">{t('comun.pantallaFallo')}</p>
      <button onClick={() => window.location.reload()} className="rounded-lg px-3 py-1.5 text-[13px] ring-1 ring-(--line) hover:bg-(--raised)">
        {t('comun.recargar')}
      </button>
    </div>
  );
}

export default class ErrorBoundary extends Component<{ children: ReactNode; clave?: string }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    if (!esErrorDeChunk(error)) return;
    let marca: string | null = null;
    try {
      marca = sessionStorage.getItem(MARCA_RECARGA);
    } catch {
      // Sin almacenamiento: sin marca, se intenta una vez.
    }
    if (!debeRecargar(marca)) return;
    try {
      sessionStorage.setItem(MARCA_RECARGA, String(Date.now()));
    } catch {
      // Sin almacenamiento no hay forma de evitar un bucle: mejor no recargar.
      return;
    }
    window.location.reload();
  }

  componentDidUpdate(prev: { clave?: string }) {
    // Al cambiar de pantalla, el error de la anterior no se arrastra.
    if (prev.clave !== this.props.clave && this.state.error) this.setState({ error: null });
  }

  render() {
    return this.state.error ? <FalloPantalla /> : this.props.children;
  }
}
