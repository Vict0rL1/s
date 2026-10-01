/**
 * De lo que escribes en la paleta a un `tsquery` de Postgres. Puro, para
 * poder probarlo sin base.
 *
 * Misma normalización que la columna `search` del esquema (minúsculas y sin
 * acentos), y cada palabra como prefijo: "midt eco" encuentra "Midterm ECON".
 * Nada de lo escrito llega crudo al `tsquery`: sólo letras y números, así un
 * "&" o un ":" no rompen la consulta.
 */
const DE = "áàäâéèëêíìïîóòöôúùüûñç";
const A = "aaaaeeeeiiiioooouuuunc";

export function fold(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) {
    const i = DE.indexOf(ch);
    out += i >= 0 ? A[i] : ch;
  }
  return out;
}

export function toTsQuery(q: string): string | null {
  const palabras = fold(q)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6);
  if (!palabras.length) return null;
  return palabras.map((w) => `${w}:*`).join(" & ");
}

/** Para un `ilike`: sin comodines ni separadores de PostgREST. */
export function likeSafe(q: string): string {
  return q.replace(/[%_*,()\\]/g, " ").trim().slice(0, 80);
}
