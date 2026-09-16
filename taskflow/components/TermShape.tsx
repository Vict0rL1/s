import Link from "next/link";
import { MONTHS_SHORT, addDays, dayOfMonth, monthOf, startOfWeek } from "@/lib/date";
import type { Task } from "@/lib/types";

/** Cuántas semanas hacia adelante se dibujan. Un trimestre cabe casi entero. */
const SEMANAS = 10;

/**
 * La forma del trimestre: una tira con lo que vence en cada una de las próximas
 * semanas.
 *
 * Por qué existe. La lista de Tareas ordena bien, pero es plana: tres entregas
 * separadas por cuatro días se leen igual que tres separadas por cuatro
 * semanas. Y la vista de Semana enseña siete días, así que un embudo a tres
 * semanas de distancia es invisible hasta que ya lo tienes encima.
 *
 * Esta tira contesta una sola pregunta —«¿cuándo se pone fea la cosa?»— y la
 * contesta con semanas de anticipación. Cada celda lleva al `/semana?w=N` que
 * le toca, así que también sirve para navegar.
 *
 * No hace consultas nuevas: `loadTasks` ya trae todo.
 */
export function TermShape({
  tasks,
  today,
  viewing = 0,
}: {
  tasks: Task[];
  today: string;
  /** Semana que se está mirando arriba, para marcarla en la tira. */
  viewing?: number;
}) {
  const lunes = startOfWeek(today);

  const semanas = Array.from({ length: SEMANAS }, (_, i) => {
    const desde = addDays(lunes, i * 7);
    const hasta = addDays(desde, 6);
    const dentro = tasks.filter(
      (t) => !t.done && t.due_date && t.due_date >= desde && t.due_date <= hasta,
    );
    return {
      offset: i,
      desde,
      hasta,
      total: dentro.length,
      altas: dentro.filter((t) => t.priority === 1).length,
      titulos: dentro.map((t) => t.title),
    };
  });

  // Si no hay nada pendiente en todo el horizonte, la tira sólo estorba.
  const pico = Math.max(...semanas.map((s) => s.total));
  if (pico === 0) return null;

  return (
    <section className="shape" aria-label="Próximas semanas">
      <div className="shapehead">
        <span className="eyebrow">Lo que viene</span>
        <span className="sub">{SEMANAS} semanas</span>
      </div>

      <ol className="shaperow">
        {semanas.map((s) => (
          <li key={s.offset}>
            <Link
              // `blank`, no `empty`: ya hay una clase `.empty` genérica para los
              // estados vacíos, y compartir el nombre le metía su padding a la celda.
              className={"shapecell" + (s.altas ? " hot" : "") + (s.total ? "" : " blank")}
              href={s.offset === 0 ? "/semana" : `/semana?w=${s.offset}`}
              // El título nativo es el detalle: quien quiera saber qué hay, lo
              // ve sin que la tira tenga que crecer.
              title={s.titulos.length ? s.titulos.join("\n") : "Nada pendiente"}
              aria-current={s.offset === viewing ? "page" : undefined}
            >
              <span className="shapecount">{s.total || ""}</span>
              {/* El riel tiene alto fijo para que el porcentaje de la barra
                  signifique algo; si no, `height: 60%` no tiene de qué ser el
                  60 por ciento. */}
              <span className="shapetrack">
                <span
                  className="shapebar"
                  // Proporcional al pico, no absoluta: la tira compara semanas
                  // entre sí, que es la pregunta real.
                  style={{ height: s.total ? `${Math.round((s.total / pico) * 100)}%` : "2px" }}
                />
              </span>
              <span className="shapeweek">
                {dayOfMonth(s.desde)} {MONTHS_SHORT[monthOf(s.desde)]}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
