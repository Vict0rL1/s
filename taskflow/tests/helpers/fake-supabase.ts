/**
 * Un cliente de Supabase de mentira que no responde nada útil pero ANOTA cada
 * consulta: tabla, método y argumentos de cada filtro. Sirve para comprobar
 * cosas que la RLS esconde en producción, como que una consulta hecha con la
 * service role lleve su `user_id`.
 */
export type Call = { method: string; args: unknown[] };
export type Query = { table: string; calls: Call[] };

export function fakeSupabase(result: (q: Query) => unknown = () => ({ data: [], error: null, count: 0 })) {
  const queries: Query[] = [];

  function builder(q: Query): unknown {
    const settle = () => Promise.resolve(result(q));
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => settle().then(ok, ko);
          }
          return (...args: unknown[]) => {
            q.calls.push({ method: prop, args });
            if (prop === "maybeSingle" || prop === "single") {
              return Promise.resolve({ data: null, error: null });
            }
            return builder(q);
          };
        },
      },
    );
  }

  const client = {
    from(table: string) {
      const q: Query = { table, calls: [] };
      queries.push(q);
      return builder(q);
    },
  };

  return { client, queries };
}

/** ¿La consulta filtra por esa columna con ese valor? */
export const filtersBy = (q: Query, column: string, value: unknown) =>
  q.calls.some((c) => c.method === "eq" && c.args[0] === column && c.args[1] === value);
