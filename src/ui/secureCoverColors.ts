/**
 * KAN-295: secure-cover colour swatches + pure HEX/RGB helpers for the
 * agent UI colour picker.
 *
 * The platform stores the secure-cover sheet colour as an arbitrary string
 * (`secureCoverSheetColorName`). Historically that was a colour name such
 * as "WHITE" or "RED". With KAN-295 the agent UI offers a HEX field, RGB
 * sliders, a native `<input type="color">` picker, and a row of
 * recommended swatches — but the field on the wire is still a plain string
 * so existing printers that already use a named value keep working without
 * a migration.
 *
 * Each swatch records:
 *  - `label`   — what the operator sees on the chip ("White", "Sunrise…")
 *  - `value`   — what is written to the form / sent to the backend. For
 *                legacy-friendly colours this is the upper-case name; for
 *                accent colours that have no canonical name on the backend
 *                it is the HEX value itself.
 *  - `preview` — the actual HEX colour we paint the chip with on screen.
 *
 * The recommended set leads with the high-contrast monochromes a real
 * print shop reaches for first (white, kraft, black), then a couple of
 * brand-safe accents.
 */

export interface SecureCoverSwatch {
  /** Human-readable label shown on the recommendation chip. */
  label: string
  /** The string written to the `secureCoverSheetColorName` form input. */
  value: string
  /** The HEX colour the chip preview / colour picker syncs to. */
  preview: string
}

/**
 * Recommended secure-cover swatches. The legacy named values (WHITE,
 * BLACK, KRAFT, RED, BLUE, GREEN, YELLOW) keep round-tripping unchanged;
 * the accents store the HEX directly because the backend has no canonical
 * name for them.
 */
export const RECOMMENDED_SECURE_COVER_SWATCHES: ReadonlyArray<SecureCoverSwatch> = [
  { label: 'White', value: 'WHITE', preview: '#FFFFFF' },
  { label: 'Kraft', value: 'KRAFT', preview: '#C9A878' },
  { label: 'Black', value: 'BLACK', preview: '#1A1A1A' },
  { label: 'Red', value: 'RED', preview: '#C0392B' },
  { label: 'Blue', value: 'BLUE', preview: '#1F4E8C' },
  { label: 'Green', value: 'GREEN', preview: '#2E7D45' },
  { label: 'Yellow', value: 'YELLOW', preview: '#F5C518' },
  { label: 'Slate', value: '#475467', preview: '#475467' },
]

/** RGB triplet — each channel clamped 0..255. */
export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * Normalise an arbitrary user-typed string into a canonical 6-digit
 * lowercase HEX (`#rrggbb`) when possible.
 *
 *  - Accepts `#rgb` short form, `#rrggbb`, with or without the leading `#`.
 *  - Trims whitespace and lower-cases.
 *  - Returns `null` for anything else (named colours, blanks, gibberish).
 *
 * This is a pure helper exported so the picker contract can be unit-tested
 * without a DOM.
 */
export function normalizeHexColor(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const trimmed = String(raw).trim().toLowerCase()
  if (!trimmed) return null
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if (/^[0-9a-f]{3}$/.test(withoutHash)) {
    const r = withoutHash[0]
    const g = withoutHash[1]
    const b = withoutHash[2]
    return `#${r}${r}${g}${g}${b}${b}`
  }
  if (/^[0-9a-f]{6}$/.test(withoutHash)) {
    return `#${withoutHash}`
  }
  return null
}

/** Parse a HEX colour into an RGB triplet. Returns `null` if invalid. */
export function parseHexColor(raw: string | null | undefined): Rgb | null {
  const hex = normalizeHexColor(raw)
  if (!hex) return null
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

/** Clamp a raw number (or numeric string) into the 0..255 RGB channel range. */
export function clampChannel(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 255) return 255
  return Math.round(n)
}

/** Clamp an entire RGB triplet to the 0..255 range. */
export function clampRgb(rgb: { r: number; g: number; b: number }): Rgb {
  return { r: clampChannel(rgb.r), g: clampChannel(rgb.g), b: clampChannel(rgb.b) }
}

/** Encode an RGB triplet as `#rrggbb` (lower-case). */
export function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  const clamped = clampRgb(rgb)
  const channel = (n: number) => n.toString(16).padStart(2, '0')
  return `#${channel(clamped.r)}${channel(clamped.g)}${channel(clamped.b)}`
}

/**
 * Best-effort resolver for the picker: given the raw form value (which may
 * be a HEX, a swatch name, or junk), return the HEX colour the picker
 * preview should paint. Falls back to the white swatch preview so the
 * picker is never visually broken.
 */
export function resolvePreviewHex(raw: string | null | undefined): string {
  const direct = normalizeHexColor(raw)
  if (direct) return direct
  const trimmed = String(raw ?? '').trim().toUpperCase()
  const matched = RECOMMENDED_SECURE_COVER_SWATCHES.find(
    (swatch) => swatch.value.toUpperCase() === trimmed,
  )
  if (matched) return matched.preview.toLowerCase()
  return '#ffffff'
}
