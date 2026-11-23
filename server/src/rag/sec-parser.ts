import { htmlToText } from '../lib/html-text.js';

export interface ParsedSection {
  sectionCode: string;
  sectionTitle: string;
  orderIndex: number;
  content: string;
}

export function cleanSecHtml(html: string): string {
  return htmlToText(html);
}

function extractItemCode(line: string, isPart2: boolean, is10Q: boolean): { code: string; title: string } | null {
  const clean = line.replace(/\s+/g, ' ').trim();
  const match = clean.match(/^item\s+([0-9]+[a-z]?)\b[\.:\-]?\s*(.*)$/i);
  if (!match) return null;

  const rawItemNum = match[1].toUpperCase();
  const rawTitle = match[2].trim();

  // If the line is just a reference like "Item 1 of this report" or "Item 1A in our", ignore
  if (/^(?:of|in|for|and|to|we|our|under)\b/i.test(rawTitle)) {
    return null;
  }

  // Must have some descriptive text unless it's followed by a known section title
  if (rawTitle.length < 2 && !/^(?:1a|1c|1|2|3|4|5|6|7a|7|8|9a|9b|9c|10|11|12|13|14|15)$/i.test(rawItemNum)) {
    return null;
  }

  if (is10Q) {
    const partPrefix = isPart2 ? 'PART_II_' : 'PART_I_';
    return {
      code: `${partPrefix}ITEM_${rawItemNum}`,
      title: clean,
    };
  }

  return {
    code: `ITEM_${rawItemNum}`,
    title: clean,
  };
}

export function parseSecSections(htmlOrText: string, form: '10-K' | '10-Q'): ParsedSection[] {
  const text = htmlOrText.includes('<') ? cleanSecHtml(htmlOrText) : htmlOrText;
  const lines = text.split('\n');
  const is10Q = form === '10-Q';

  interface SectionMarker {
    code: string;
    title: string;
    lineIdx: number;
    charIdx: number;
  }

  const markers: SectionMarker[] = [];
  let isPart2 = false;
  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    const lineLen = lines[i].length + 1;

    if (/^part\s+ii\b/i.test(rawLine)) {
      isPart2 = true;
    } else if (/^part\s+i\b/i.test(rawLine)) {
      isPart2 = false;
    }

    // Filter candidate heading lines:
    // "Item X. Title" or "Item X - Title"
    if (/^item\s+(?:1a|1c|1|2|3|4|5|6|7a|7|8|9a|9b|9c|10|11|12|13|14|15)\b[^\n\r]*[a-zA-Z]{3,}/i.test(rawLine)) {
      const itemInfo = extractItemCode(rawLine, isPart2, is10Q);
      if (itemInfo) {
        markers.push({
          code: itemInfo.code,
          title: itemInfo.title,
          lineIdx: i,
          charIdx: charOffset,
        });
      }
    }

    charOffset += lineLen;
  }

  // If no sections were identified, return full document as single section
  if (markers.length === 0) {
    return [
      {
        sectionCode: 'FULL_DOCUMENT',
        sectionTitle: 'Full Document',
        orderIndex: 0,
        content: text.trim(),
      },
    ];
  }

  const result: ParsedSection[] = [];

  // If substantial content exists before the first section marker (e.g. cover page)
  if (markers[0].charIdx > 500) {
    const coverText = text.slice(0, markers[0].charIdx).trim();
    if (coverText.length > 100) {
      result.push({
        sectionCode: 'COVER',
        sectionTitle: 'Cover Page and General Information',
        orderIndex: 0,
        content: coverText,
      });
    }
  }

  for (let idx = 0; idx < markers.length; idx++) {
    const current = markers[idx];
    const next = markers[idx + 1];
    const startIdx = current.charIdx;
    const endIdx = next ? next.charIdx : text.length;
    const content = text.slice(startIdx, endIdx).trim();

    result.push({
      sectionCode: current.code,
      sectionTitle: current.title,
      orderIndex: result.length,
      content,
    });
  }

  return result;
}
