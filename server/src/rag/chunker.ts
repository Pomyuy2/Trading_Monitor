export interface ChunkSectionParams {
  documentId: string;
  sectionId: string;
  symbol: string;
  form: string;
  filingDate: Date;
  filingDateStr: string;
  reportDate?: Date | null;
  reportDateStr?: string | null;
  sectionCode: string;
  sectionTitle: string;
  content: string;
}

export interface GeneratedChunk {
  id: string; // stable citation ID: SEC-{symbol}-{form}-{filingDateStr}-{sectionCode}-c{index}
  documentId: string;
  sectionId: string;
  symbol: string;
  form: string;
  filingDate: Date;
  filingDateStr: string;
  reportDate?: Date | null;
  reportDateStr?: string | null;
  sectionCode: string;
  sectionTitle: string;
  chunkIndex: number;
  tokenCount: number;
  content: string;
}

export interface ChunkerOptions {
  targetChunkChars?: number;
  maxChunkChars?: number;
  overlapChars?: number;
}

export function chunkSection(
  params: ChunkSectionParams,
  options: ChunkerOptions = {},
): GeneratedChunk[] {
  const targetChars = options.targetChunkChars ?? 2000;
  const maxChars = options.maxChunkChars ?? 3000;
  const overlapChars = options.overlapChars ?? 300;

  const text = params.content.trim();
  if (!text) return [];

  // If text is smaller than maxChars, return a single chunk
  if (text.length <= maxChars) {
    const chunkId = `SEC-${params.symbol}-${params.form}-${params.filingDateStr}-${params.sectionCode}-c1`;
    return [
      {
        id: chunkId,
        documentId: params.documentId,
        sectionId: params.sectionId,
        symbol: params.symbol,
        form: params.form,
        filingDate: params.filingDate,
        filingDateStr: params.filingDateStr,
        reportDate: params.reportDate ?? null,
        reportDateStr: params.reportDateStr ?? null,
        sectionCode: params.sectionCode,
        sectionTitle: params.sectionTitle,
        chunkIndex: 1,
        tokenCount: Math.max(1, Math.ceil(text.length / 4)),
        content: text,
      },
    ];
  }

  // Break text into paragraphs or sentences
  const paragraphs = text.split(/\n\s*\n/);
  const segments: string[] = [];

  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxChars) {
      segments.push(trimmed);
    } else {
      // Split large paragraph into sentences or smaller blocks
      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      let subAccum = '';

      for (const sent of sentences) {
        if (!sent.trim()) continue;
        if (subAccum.length + sent.length + 1 > targetChars && subAccum.length > 0) {
          segments.push(subAccum.trim());
          subAccum = sent;
        } else {
          subAccum = subAccum ? `${subAccum} ${sent}` : sent;
        }
      }

      if (subAccum.trim()) {
        segments.push(subAccum.trim());
      }
    }
  }

  // Accumulate segments into chunks with overlap
  const chunks: GeneratedChunk[] = [];
  let currentChunk = '';
  let chunkIndex = 1;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (!currentChunk) {
      currentChunk = seg;
    } else if (currentChunk.length + seg.length + 2 <= targetChars) {
      currentChunk = `${currentChunk}\n\n${seg}`;
    } else {
      // Current chunk is full, emit it
      const chunkId = `SEC-${params.symbol}-${params.form}-${params.filingDateStr}-${params.sectionCode}-c${chunkIndex}`;
      chunks.push({
        id: chunkId,
        documentId: params.documentId,
        sectionId: params.sectionId,
        symbol: params.symbol,
        form: params.form,
        filingDate: params.filingDate,
        filingDateStr: params.filingDateStr,
        reportDate: params.reportDate ?? null,
        reportDateStr: params.reportDateStr ?? null,
        sectionCode: params.sectionCode,
        sectionTitle: params.sectionTitle,
        chunkIndex,
        tokenCount: Math.max(1, Math.ceil(currentChunk.length / 4)),
        content: currentChunk,
      });

      chunkIndex++;

      // Retain overlap from end of current chunk
      if (overlapChars > 0 && currentChunk.length > overlapChars) {
        const overlapSlice = currentChunk.slice(-overlapChars);
        // Find first word boundary in overlapSlice
        const spaceIdx = overlapSlice.indexOf(' ');
        const cleanOverlap = spaceIdx !== -1 ? overlapSlice.slice(spaceIdx + 1).trim() : overlapSlice.trim();
        currentChunk = cleanOverlap ? `${cleanOverlap}\n\n${seg}` : seg;
      } else {
        currentChunk = seg;
      }
    }
  }

  if (currentChunk.trim()) {
    const chunkId = `SEC-${params.symbol}-${params.form}-${params.filingDateStr}-${params.sectionCode}-c${chunkIndex}`;
    chunks.push({
      id: chunkId,
      documentId: params.documentId,
      sectionId: params.sectionId,
      symbol: params.symbol,
      form: params.form,
      filingDate: params.filingDate,
      filingDateStr: params.filingDateStr,
      reportDate: params.reportDate ?? null,
      reportDateStr: params.reportDateStr ?? null,
      sectionCode: params.sectionCode,
      sectionTitle: params.sectionTitle,
      chunkIndex,
      tokenCount: Math.max(1, Math.ceil(currentChunk.length / 4)),
      content: currentChunk.trim(),
    });
  }

  return chunks;
}
