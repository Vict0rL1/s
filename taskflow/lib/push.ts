import "server-only";

import webpush from "web-push";
import { VAPID_PRIVATE_KEY, VAPID_SUBJECT, pushSendConfigured } from "./env.server";
import { VAPID_PUBLIC_KEY } from "./env";
import { addDays, daysBetween, minsToHHMM } from "./date";
import type { DayEvent, Profile, Task } from "./types";

export type Digest = { title: string; body: string; url: string };

/**
 * Los dos avisos del día.
 *
 * `morning` mira hoy: lo que vence y lo que ya se pasó. `night` mira mañana,
 * la noche anterior, que es cuando todavía puedes hacer algo al respecto
 * (dejar la lectura hecha, poner el despertador más temprano).
 */
export type DigestKind = "morning" | "night";

export type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Cuántos títulos caben en el cuerpo antes de que deje de leerse de un vistazo. */
const MAX_TITULOS = 3;

function lista(items: { title: string }[]): string {
  const titulos = items.slice(0, MAX_TITULOS).map((t) => t.title);
  const resto = items.length - titulos.length;
  return titulos.join(" · ") + (resto > 0 ? ` y ${resto} más` : "");
}

/**
 * Arma el aviso, o `null` si no hay nada que decir.
 *
 * Devolver `null` es la parte importante. `PLAN.md` lo advierte: una app de
 * productividad que notifica de más se silencia y se muere.
 *
 * `events` puede traer varios días; cada modo se queda con el suyo (`DayEvent`
 * ya sabe a qué día local pertenece). Así quien llama no puede equivocarse de
 * rango y mandar la agenda de mañana en el aviso de la mañana.
 */
export function buildDigest(
  kind: DigestKind,
  tasks: Task[],
  events: DayEvent[],
  today: string,
): Digest | null {
  return kind === "night" ? nightDigest(tasks, events, today) : morningDigest(tasks, events, today);
}

function porHora(events: DayEvent[], day: string) {
  return events.filter((e) => e.day === day && e.start != null).sort((a, b) => a.start! - b.start!);
}

/* --------------------------------------------------------- por la mañana */

function morningDigest(tasks: Task[], events: DayEvent[], today: string): Digest | null {
  const pendientes = tasks.filter((t) => !t.done && t.due_date && t.due_date <= today);
  const atrasadas = pendientes.filter((t) => daysBetween(today, t.due_date!) < 0);
  const hoy = pendientes.filter((t) => t.due_date === today);
  const conHora = porHora(events, today);

  if (!pendientes.length && !conHora.length) return null;

  // Los dos números tienen que sumar: `hoy` ya excluye lo atrasado, así que
  // "2 para hoy · 1 atrasada" son tres cosas, no dos con una repetida.
  const cuentas: string[] = [];
  if (hoy.length) {
    cuentas.push(
      atrasadas.length
        ? `${hoy.length} para hoy`
        : `${hoy.length} tarea${hoy.length > 1 ? "s" : ""} para hoy`,
    );
  }
  if (atrasadas.length) {
    cuentas.push(`${atrasadas.length} atrasada${atrasadas.length > 1 ? "s" : ""}`);
  }
  const title = cuentas.length ? cuentas.join(" · ") : "Tu día en TaskFlow";

  const partes: string[] = [];

  // Primero lo atrasado: es lo que de verdad hay que mirar.
  const enOrden = [...atrasadas, ...hoy];
  if (enOrden.length) partes.push(lista(enOrden));

  if (conHora.length) {
    const primero = conHora[0];
    partes.push(
      conHora.length === 1
        ? `${minsToHHMM(primero.start!)} ${primero.title}`
        : `${conHora.length} en la agenda, desde ${minsToHHMM(primero.start!)}`,
    );
  }

  return { title, body: partes.join(" — "), url: "/hoy" };
}

/* ---------------------------------------------------------- la noche antes */

/**
 * El aviso de la noche habla de MAÑANA.
 *
 * Una decisión a propósito: si mañana no hay nada, no se manda, aunque hoy
 * hayas dejado cosas sin hacer. Lo atrasado ya sale en el aviso de la mañana,
 * y repetirlo por la noche sería el mismo texto dos veces al día — que es
 * exactamente como se consigue que alguien apague las notificaciones. Lo
 * pendiente de hoy aparece, pero como cola de un aviso que ya tenía motivo.
 */
function nightDigest(tasks: Task[], events: DayEvent[], today: string): Digest | null {
  const manana = addDays(today, 1);

  const vencenManana = tasks.filter((t) => !t.done && t.due_date === manana);
  const arrastre = tasks.filter((t) => !t.done && t.due_date && t.due_date <= today);
  const conHora = porHora(events, manana);

  if (!vencenManana.length && !conHora.length) return null;

  const primero = conHora[0];

  const title = vencenManana.length
    ? `Mañana: ${vencenManana.length} tarea${vencenManana.length > 1 ? "s" : ""}`
    : `Mañana empiezas a las ${minsToHHMM(primero.start!)}`;

  const partes: string[] = [];
  if (vencenManana.length) partes.push(lista(vencenManana));

  if (primero) {
    // Si el título ya dijo la hora, el cuerpo no la repite: dice con qué.
    if (vencenManana.length) {
      partes.push(
        conHora.length === 1
          ? `${minsToHHMM(primero.start!)} ${primero.title}`
          : `${conHora.length} en la agenda, desde ${minsToHHMM(primero.start!)}`,
      );
    } else {
      partes.push(
        conHora.length === 1 ? primero.title : `${primero.title} y ${conHora.length - 1} más`,
      );
    }
  }

  if (arrastre.length) {
    partes.push(`${arrastre.length} sin hacer de hoy`);
  }

  return { title, body: partes.join(" — "), url: "/semana" };
}

/* ------------------------------------------------------- ¿toca avisar ya? */

/**
 * Qué aviso toca a esta hora local, si toca alguno.
 *
 * El reloj corre cada hora y pregunta. Las ventanas son anchas a propósito:
 * GitHub Actions no dispara al minuto y a veces se salta una hora entera, así
 * que una comparación exacta (`hora === 7`) se perdería el aviso ese día. Que
 * no se repita dentro de la ventana no lo garantiza esta función — lo
 * garantiza `digest_log`.
 */
export function digestDue(profile: Profile, hour: number): DigestKind | null {
  const manana = Math.min(11, Math.max(5, profile.day_start));
  const noche = Math.min(23, Math.max(18, profile.day_end - 2));
  if (hour >= noche) return "night";
  if (hour >= manana && hour < 12) return "morning";
  return null;
}

/* ------------------------------------------------------------------ envío */

let configurado = false;

function configurar() {
  if (configurado) return;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
  configurado = true;
}

export type SendResult = { enviadas: number; caducadas: string[]; fallidas: number };

/**
 * Manda el aviso a cada navegador suscrito.
 *
 * Los endpoints que responden 404 o 410 están muertos — el navegador se
 * desinstaló o revocó el permiso — y se devuelven para borrarlos. Si no, la
 * tabla se llena de suscripciones fantasma que fallan todos los días.
 */
export async function sendDigest(
  subs: PushSubscriptionRow[],
  digest: Digest,
): Promise<SendResult> {
  if (!pushSendConfigured()) return { enviadas: 0, caducadas: [], fallidas: 0 };
  configurar();

  const payload = JSON.stringify(digest);
  const caducadas: string[] = [];
  let enviadas = 0;
  let fallidas = 0;

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 12 * 60 * 60 },
        );
        enviadas++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) caducadas.push(s.endpoint);
        else fallidas++;
      }
    }),
  );

  return { enviadas, caducadas, fallidas };
}
