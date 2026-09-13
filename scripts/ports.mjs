// The app's default ports, in ONE place.
//
// ===========================================================================
// WHY NOT 5173 AND 4000
// ===========================================================================
// 5173 is Vite's own default, so EVERY Vite project on the machine wants it, and
// 4000 is the default of about half the Node APIs ever written. Sharing them means
// whichever app you start second loses — and worse, it means
// `http://localhost:5173` is a different app depending on what you launched that
// morning, so the address cannot be bookmarked or added to a phone's home screen.
//
// 7373 / 7374 are not the default of any common dev tool, they are adjacent so the
// pair is easy to remember, and they are stable — which is the actual requirement.
// Automatic fallback (see dev.mjs) is still there as a safety net, but the point is
// that it should almost never fire, because a moving address is nearly as annoying
// as a clashing one.
//
// Imported by scripts/dev.mjs, scripts/phone.mjs and web/vite.config.ts.
// server/src/config.ts repeats DEFAULT_API with a comment pointing here, because it
// lives in a separate workspace and reaching across would be worse than one
// duplicated number.

/** The web app — the address you actually open and bookmark. */
export const DEFAULT_WEB = 7373;

/** The REST API. One above the web port, on purpose. */
export const DEFAULT_API = 7374;

/**
 * Where `npm run preview --workspace web` serves the built bundle.
 *
 * A separate port so the dev server and the preview can run at the same time —
 * useful when checking that a production build behaves like the dev one.
 */
export const DEFAULT_PREVIEW = 7375;
