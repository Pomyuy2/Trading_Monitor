/** Minimal HTML → plain text for SEC filings (no external parser needed). */
const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', reg: '®', trade: '™', copy: '©', sect: '§', dollar: '$', percnt: '%',
};

export function htmlToText(html: string): string {
  return html
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, ' ') // inline-XBRL hidden facts
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, '\n')
    .replace(/<\s*\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Item 7 (Management's Discussion and Analysis) of a 10-K. The table of contents
 * also lists "Item 7", so take the longest span between an "Item 7" heading and
 * the next "Item 7A" / "Item 8" heading.
 */
export function mdaSection(text: string): string {
  const starts = [...text.matchAll(/item\s*7\.?\s*[\n ]*management[’'`]?s\s+discussion/gi)].map((m) => m.index!);
  let best = '';
  for (const s of starts) {
    const rest = text.slice(s);
    // Only a heading ends the section ("Item 7A." / "Item 8." at a line start), not a cross-reference
    // like "...included in Part II, Item 8 of this Form 10-K".
    const end = rest.slice(50).search(/\n\s*item\s*(7a|8)\s*\./i);
    const span = end >= 0 ? rest.slice(0, end + 50) : rest.slice(0, 200_000);
    if (span.length > best.length) best = span;
  }
  return best || text;
}
