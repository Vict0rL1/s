// Presentation helpers (Spanish UI).

export function pct(p: number | null | undefined, digits = 0): string {
  if (p == null) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

export function surfaceLabelEs(surface: string | null): string {
  switch ((surface || '').toLowerCase()) {
    case 'hard':
      return 'Dura';
    case 'clay':
      return 'Arcilla';
    case 'grass':
      return 'Hierba';
    case 'carpet':
      return 'Carpeta';
    default:
      return surface || '—';
  }
}

/** Accent color per surface (used sparingly, always paired with a text label). */
export function surfaceColor(surface: string | null): string {
  switch ((surface || '').toLowerCase()) {
    case 'hard':
      return '#38bdf8'; // sky
    case 'clay':
      return '#fb923c'; // orange
    case 'grass':
      return '#4ade80'; // green
    default:
      return '#94a3b8';
  }
}

export function confidenceLabelEs(tier: string): string {
  switch (tier) {
    case 'toss_up':
      return 'muy parejo';
    case 'slight':
      return 'ligera ventaja';
    case 'clear':
      return 'favorito claro';
    case 'strong':
      return 'favorito fuerte';
    default:
      return tier;
  }
}

export function formatDate(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '';
  if (yyyymmdd.length === 8) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  return yyyymmdd;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Convert an IOC country code to a flag emoji (best-effort). */
export function flag(ioc: string | null): string {
  if (!ioc || ioc.length < 2) return '';
  const map: Record<string, string> = {
    SRB: 'RS', ESP: 'ES', ITA: 'IT', RUS: 'RU', GER: 'DE', GRE: 'GR', NOR: 'NO',
    USA: 'US', BUL: 'BG', POL: 'PL', BLR: 'BY', KAZ: 'KZ', TUN: 'TN', CZE: 'CZ',
    CHN: 'CN', LAT: 'LV', SUI: 'CH', FRA: 'FR', GBR: 'GB', ARG: 'AR', AUS: 'AU',
    CAN: 'CA', CRO: 'HR', DEN: 'DK', NED: 'NL', AUT: 'AT', BRA: 'BR', JPN: 'JP',
  };
  const iso2 = map[ioc.toUpperCase()] ?? ioc.slice(0, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2)) return '';
  return String.fromCodePoint(...[...iso2].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * The flag for a league's country.
 *
 * The five sports' config files spell the country two different ways: football
 * stores a ready-made "🇪🇸 España" (because a league label wants the name too),
 * the others store a bare ISO-2 code. Rather than migrate four config files for
 * a decoration, this accepts both — and returns an empty string for anything it
 * cannot resolve, so a missing flag is a missing flag and never a tofu box.
 */
export function countryFlag(country: string | null | undefined): string {
  if (!country) return '';
  const trimmed = country.trim();
  // Already an emoji (regional indicators, or a tag sequence like the England
  // flag): take the leading glyph cluster as-is.
  const first = [...trimmed][0] ?? '';
  if (first.codePointAt(0)! >= 0x1f1e6) {
    const upTo = trimmed.indexOf(' ');
    return upTo > 0 ? trimmed.slice(0, upTo) : trimmed;
  }
  const code = trimmed.slice(0, 2).toUpperCase();
  if (code === 'EU') return '🇪🇺';
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
