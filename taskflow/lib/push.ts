import "server-only";

import webpush from "web-push";
import { VAPID_PRIVATE_KEY, VAPID_SUBJECT, pushSendConfigured } from "./env.server";
import { VAPID_PUBLIC_KEY } from "./env";
import { daysBetween, minsToHHMM } from "./date";
import type { DayEvent, Task } from "./types";

export type Digest = { title: string; body: string; url: string };

export type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Cuántos títulos caben en el cuerpo antes de que deje de leerse de un vistazo. */
const MAX_TITULOS = 3;

/**
 * Arma el aviso del día, o `null` si no hay nada que decir.
 *
 * Devolver `null` es la parte importante. `PLAN.md` lo advierte: una app de
 * productividad que notifica de más se silencia y se muere. Si no hay nada
 * atrasado, nada que venza hoy y nada en la agenda, hoy no se avisa.
 */
export function buildDigest(tasks: Task[], events: DayEvent[], today: string): Digest | null {
  const pendientes = tasks.filter((t) => !t.done && t.due_date && t.due_date <= today);
  const atrasadas = pendientes.filter((t) => daysBetween(today, t.due_date!) < 0);
  const hoy = pendientes.filter((t) => t.due_date === today);
  const conHora = events.filter((e) => e.start != null).sort((a, b) => a.start! - b.start!);

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
  const titulos = enOrden.slice(0, MAX_TITULOS).map((t) => t.title);
  if (titulos.length) {
    const resto = enOrden.length - titulos.length;
    partes.push(titulos.join(" · ") + (resto > 0 ? ` y ${resto} más` : ""));
  }

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
