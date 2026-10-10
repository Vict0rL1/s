// Pinta los bloques de lib/markdown.ts (los informes, Fase 6.9). Los enlaces son internos y van
// por el router; nada pasa por innerHTML.
import { Link } from 'react-router';
import { leerMarkdown, type Trozo } from '../lib/markdown';

function Trozos({ xs }: { xs: Trozo[] }) {
  return (
    <>
      {xs.map((x, i) =>
        x.t === 'negrita' ? (
          <strong key={i} className="font-semibold text-(--ink-strong)">{x.v}</strong>
        ) : x.t === 'enlace' ? (
          <Link key={i} to={x.href} className="underline decoration-(--line-strong) underline-offset-2 hover:text-(--ink-strong)">{x.v}</Link>
        ) : (
          <span key={i}>{x.v}</span>
        ),
      )}
    </>
  );
}

export default function Markdown({ texto }: { texto: string }) {
  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-(--ink-body)">
      {leerMarkdown(texto).map((b, i) => {
        if (b.tipo === 'h1') return <h2 key={i} className="text-[20px] font-semibold text-(--ink-strong)"><Trozos xs={b.trozos} /></h2>;
        if (b.tipo === 'h2') return <h3 key={i} className="pt-2 text-[16px] font-semibold text-(--ink-strong)"><Trozos xs={b.trozos} /></h3>;
        if (b.tipo === 'h3') return <h4 key={i} className="text-[14px] font-semibold text-(--ink-strong)"><Trozos xs={b.trozos} /></h4>;
        if (b.tipo === 'nota') return <p key={i} className="text-[12px] italic text-(--ink-muted)"><Trozos xs={b.trozos} /></p>;
        if (b.tipo === 'ul')
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.items.map((it, j) => (
                <li key={j}><Trozos xs={it} /></li>
              ))}
            </ul>
          );
        if (b.tipo === 'tabla')
          return (
            <div key={i} className="overflow-x-auto" tabIndex={0}>
              <table className="w-full min-w-[22rem] text-[13px] tabular-nums">
                <thead>
                  <tr className="text-left text-(--ink-muted)">
                    {b.cabecera.map((c, j) => (
                      <th key={j} className="py-1 pr-3 font-medium"><Trozos xs={c} /></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.filas.map((f, j) => (
                    <tr key={j} className="border-t border-(--line)">
                      {f.map((c, k) => (
                        <td key={k} className="py-1 pr-3 align-top"><Trozos xs={c} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return <p key={i}><Trozos xs={b.trozos} /></p>;
      })}
    </div>
  );
}
