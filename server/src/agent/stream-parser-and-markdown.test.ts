import { describe, expect, it } from 'vitest';

describe('Markdown and Internal Block Sanitization', () => {
  // Regex from MarkdownRenderer.tsx
  const stripInvestmentReport = (text: string) =>
    text.replace(/```investment_report[\s\S]*?(?:```|$)/g, '').trim();

  it('strips complete ```investment_report``` blocks from assistant responses', () => {
    const raw = `Here is our detailed outlook for NVDA:

1. **Strong Data Center Revenue**: Growth remains solid.
2. **Margin Expansion**: Operating margin > 60%.

\`\`\`investment_report
{
  "symbol": "NVDA",
  "recommendation": { "action": "BUY" }
}
\`\`\`

Let me know if you would like a sensitivity table.`;

    const cleaned = stripInvestmentReport(raw);
    expect(cleaned).toContain('Here is our detailed outlook for NVDA:');
    expect(cleaned).toContain('Let me know if you would like a sensitivity table.');
    expect(cleaned).not.toContain('```investment_report');
    expect(cleaned).not.toContain('"symbol": "NVDA"');
  });

  it('strips unclosed/in-progress ```investment_report blocks during streaming', () => {
    const inProgress = `Here is the preliminary report:\n\n\`\`\`investment_report\n{"symbol":"NVDA","currentPrice":140`;
    const cleaned = stripInvestmentReport(inProgress);
    expect(cleaned).toBe('Here is the preliminary report:');
    expect(cleaned).not.toContain('investment_report');
    expect(cleaned).not.toContain('140');
  });

  it('preserves normal code blocks (e.g. typescript, python, json)', () => {
    const code = `Here is how to calculate PE:

\`\`\`python
def pe_ratio(price, eps):
    return price / eps
\`\`\`
`;
    const cleaned = stripInvestmentReport(code);
    expect(cleaned).toContain('```python');
    expect(cleaned).toContain('def pe_ratio');
  });
});

describe('Client SSE Stream Parser Logic', () => {
  // The SSE parser algorithm implemented in web/src/lib/api.ts
  function parseSseChunks(chunks: Uint8Array[]): { eventType: string; data: Record<string, unknown> }[] {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const parsedEvents: { eventType: string; data: Record<string, unknown> }[] = [];

    for (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      // Keep last incomplete frame in buffer
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const lines = frame.split(/\r?\n/);
        let eventType = 'message';
        let dataPayload = '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // Skip empty and comment/heartbeat lines

          if (trimmed.startsWith('event:')) {
            eventType = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            const dataContent = trimmed.slice(5).trim();
            dataPayload = dataPayload ? `${dataPayload}\n${dataContent}` : dataContent;
          }
        }

        if (dataPayload) {
          try {
            parsedEvents.push({ eventType, data: JSON.parse(dataPayload) });
          } catch {}
        }
      }
    }

    return parsedEvents;
  }

  it('parses complete SSE events across fragmented chunks', () => {
    const encoder = new TextEncoder();
    const part1 = encoder.encode('event: agent_start\ndata: {"query":"AAPL"');
    const part2 = encoder.encode('}\n\nevent: text_delta\ndata: {"delta":"Hello"}\n\n');

    const events = parseSseChunks([part1, part2]);
    expect(events.length).toBe(2);
    expect(events[0].eventType).toBe('agent_start');
    expect(events[0].data).toEqual({ query: 'AAPL' });
    expect(events[1].eventType).toBe('text_delta');
    expect(events[1].data).toEqual({ delta: 'Hello' });
  });

  it('ignores heartbeat comments (: heartbeat)', () => {
    const encoder = new TextEncoder();
    const streamData = encoder.encode(
      ': heartbeat\n\n' +
        'event: tool_start\ndata: {"tool":"get_quote"}\n\n' +
        ': heartbeat\n\n' +
        'event: text_delta\ndata: {"delta":"Price: $100"}\n\n',
    );

    const events = parseSseChunks([streamData]);
    expect(events.length).toBe(2);
    expect(events[0].eventType).toBe('tool_start');
    expect(events[1].eventType).toBe('text_delta');
  });

  it('correctly handles multi-byte UTF-8 split across chunk boundaries', () => {
    const encoder = new TextEncoder();
    const fullText = 'event: text_delta\ndata: {"delta":"กำลังวิเคราะห์ 📈"}\n\n';
    const encoded = encoder.encode(fullText);

    // Split intentionally in the middle of a multi-byte character
    const splitIndex = 35; // Inside Thai unicode sequence
    const chunk1 = encoded.subarray(0, splitIndex);
    const chunk2 = encoded.subarray(splitIndex);

    const events = parseSseChunks([chunk1, chunk2]);
    expect(events.length).toBe(1);
    expect(events[0].data).toEqual({ delta: 'กำลังวิเคราะห์ 📈' });
  });

  it('supports Windows CRLF (\\r\\n\\r\\n) framing', () => {
    const encoder = new TextEncoder();
    const crlfData = encoder.encode('event: text_delta\r\ndata: {"delta":"test"}\r\n\r\n');

    const events = parseSseChunks([crlfData]);
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe('text_delta');
    expect(events[0].data).toEqual({ delta: 'test' });
  });
});
