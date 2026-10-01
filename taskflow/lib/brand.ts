/**
 * El ícono de la app, en un solo lugar. `app/icon.svg` es el favicon; los PNG
 * del manifest y el de Apple se generan a partir de este mismo dibujo, así no
 * hay binarios en el repo que se desincronicen.
 */
export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#141D1A"/>' +
  '<path d="M12 46 L26 22 L34 36 L40 27 L52 46 Z" fill="#A81F3C"/>' +
  '<circle cx="44" cy="17" r="4" fill="#F1F4F2"/>' +
  "</svg>";

export const ICON_BG = "#141D1A";

export const iconDataUri = () => `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString("base64")}`;
