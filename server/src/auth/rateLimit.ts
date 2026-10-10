// Límite de intentos de entrada, por dirección.
//
// Sin esto, una contraseña de ocho caracteres en una URL pública se prueba a fuerza bruta
// sin que nada lo frene. Con esto, cinco fallos en quince minutos bloquean la dirección
// quince minutos (429 con `Retry-After`), y cada bloqueo seguido dobla la espera.
//
// En memoria y no en la base: un contador que se pierde al reiniciar es aceptable (el
// reinicio también corta al atacante), y escribir en la base por cada intento fallido
// sería darle a quien ataca una forma de llenar el disco.

export interface OpcionesLimite {
  maxFallos: number;
  ventanaMs: number;
  bloqueoMs: number;
  /**
   * Tope de direcciones guardadas a la vez. Sin él, un barrido desde muchas direcciones (o
   * una cabecera falsificada, antes del lote A) hacía crecer el Map sin límite. Al llegar al
   * tope se desalojan las más antiguas.
   */
  maxDirecciones: number;
  /** Reloj inyectable: los tests no esperan quince minutos. */
  ahora?: () => number;
}

interface Estado {
  fallos: number[];
  bloqueadoHasta: number;
  bloqueos: number;
}

export const LIMITE_POR_DEFECTO: Omit<OpcionesLimite, 'ahora'> = { maxFallos: 5, ventanaMs: 15 * 60_000, bloqueoMs: 15 * 60_000, maxDirecciones: 10_000 };

export class LimiteDeIntentos {
  private readonly estados = new Map<string, Estado>();
  private readonly o: Required<OpcionesLimite>;

  constructor(opts: Partial<OpcionesLimite> = {}) {
    this.o = { ...LIMITE_POR_DEFECTO, ahora: () => Date.now(), ...opts } as Required<OpcionesLimite>;
  }

  /** Segundos que quedan de bloqueo, o 0 si la dirección puede intentarlo. */
  bloqueadaSegundos(clave: string): number {
    const e = this.estados.get(clave);
    if (!e) return 0;
    const resto = e.bloqueadoHasta - this.o.ahora();
    return resto > 0 ? Math.ceil(resto / 1000) : 0;
  }

  /** Registra un fallo; devuelve los segundos de bloqueo si este fallo lo dispara. */
  fallo(clave: string): number {
    const t = this.o.ahora();
    this.podar(t, !this.estados.has(clave));
    const e = this.estados.get(clave) ?? { fallos: [], bloqueadoHasta: 0, bloqueos: 0 };
    e.fallos = e.fallos.filter((x) => t - x < this.o.ventanaMs);
    e.fallos.push(t);
    if (e.fallos.length >= this.o.maxFallos) {
      e.bloqueos++;
      // Dobla con cada bloqueo seguido, hasta un día: quien insiste espera más.
      const ms = Math.min(this.o.bloqueoMs * 2 ** (e.bloqueos - 1), 24 * 3_600_000);
      e.bloqueadoHasta = t + ms;
      e.fallos = [];
      this.estados.set(clave, e);
      return Math.ceil(ms / 1000);
    }
    this.estados.set(clave, e);
    return 0;
  }

  /** Un acierto limpia la cuenta de la dirección. */
  acierto(clave: string): void {
    this.estados.delete(clave);
  }

  /** Cuántas direcciones hay guardadas (para los tests y el doctor). */
  tamano(): number {
    return this.estados.size;
  }

  /**
   * Fuera lo caducado (sin bloqueo vivo ni fallos dentro de la ventana) y, si aun así se pasa
   * del tope, fuera las más antiguas: un Map conserva el orden de inserción, así que las
   * primeras entradas son las más viejas.
   */
  private podar(t: number, haceSitio: boolean): void {
    for (const [clave, e] of this.estados) {
      const vivo = e.bloqueadoHasta > t || e.fallos.some((x) => t - x < this.o.ventanaMs);
      if (!vivo) this.estados.delete(clave);
    }
    while (haceSitio && this.estados.size >= this.o.maxDirecciones) {
      const primera = this.estados.keys().next().value;
      if (primera === undefined) break;
      this.estados.delete(primera);
    }
  }

  /** Cuántas direcciones están bloqueadas ahora mismo (para el doctor). */
  bloqueadas(): number {
    const t = this.o.ahora();
    let n = 0;
    for (const e of this.estados.values()) if (e.bloqueadoHasta > t) n++;
    return n;
  }
}
