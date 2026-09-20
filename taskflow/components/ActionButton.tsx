import type { ReactNode } from "react";

/**
 * Un botón que dispara un Server Action. Va envuelto en su propio <form>, con
 * `display:contents` para que no altere el flex de la fila (ver `form.inline`
 * en globals.css). Sin JavaScript también funciona.
 */
export function ActionButton({
  action,
  id,
  className,
  label,
  children,
  title,
  extra,
}: {
  action: (fd: FormData) => Promise<void>;
  id?: string;
  className?: string;
  label?: string;
  title?: string;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <form action={action} className="inline">
      {id ? <input type="hidden" name="id" value={id} /> : null}
      {extra}
      <button type="submit" className={className} aria-label={label} title={title}>
        {children}
      </button>
    </form>
  );
}
