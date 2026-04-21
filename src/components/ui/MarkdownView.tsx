// =============================================================
// MarkdownView — renderizador simples de markdown (sem deps)
// =============================================================
// Cobre o suficiente pro briefing da Routine:
//   headings (h1-h4), paragrafos, listas (- e 1.), negrito,
//   italico, inline code, code blocks, blockquote, hr,
//   links [texto](url), tables em markdown padrao.
// =============================================================

import React from 'react';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInline(text: string): string {
  let t = escapeHtml(text);
  // code inline
  t = t.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-[var(--color-v4-surface)] text-xs font-mono text-amber-300">$1</code>');
  // bold
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>');
  // italic
  t = t.replace(/(^|[^\*])\*([^*]+)\*/g, '$1<em class="italic">$2</em>');
  // links [t](url)
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" class="text-blue-400 hover:underline">$1</a>');
  return t;
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'blockquote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'hr' }
  | { type: 'table'; header: string[]; rows: string[][] };

function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block ```...```
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join(' ') });
      continue;
    }

    // Table (linha com |, proxima linha com separadores ---)
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s|:-]+\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (l: string) =>
        l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const header = splitRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Paragraph — agrupa linhas nao-vazias contiguas
    if (line.trim() !== '') {
      const paraLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|---)/.test(lines[i]) && !lines[i].includes('|')) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
      continue;
    }

    // Linha vazia, pula
    i++;
  }

  return blocks;
}

const HEADING_CLS: Record<number, string> = {
  1: 'text-2xl font-bold text-white mt-6 mb-3',
  2: 'text-xl font-bold text-white mt-5 mb-2',
  3: 'text-lg font-semibold text-white mt-4 mb-2',
  4: 'text-base font-semibold text-white mt-3 mb-2',
  5: 'text-sm font-semibold text-white mt-2 mb-1',
  6: 'text-xs font-semibold text-white mt-2 mb-1',
};

export const MarkdownView: React.FC<{ source: string }> = ({ source }) => {
  const blocks = React.useMemo(() => parseMarkdown(source || ''), [source]);

  return (
    <div className="text-sm text-[var(--color-v4-text)] leading-relaxed space-y-1">
      {blocks.map((b, idx) => {
        switch (b.type) {
          case 'heading': {
            const Tag = `h${b.level}` as any;
            return (
              <Tag key={idx} className={HEADING_CLS[b.level] || HEADING_CLS[4]}
                   dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
            );
          }
          case 'paragraph':
            return <p key={idx} className="my-2" dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />;
          case 'ul':
            return (
              <ul key={idx} className="list-disc list-inside ml-2 space-y-1 my-2">
                {b.items.map((it, j) => (
                  <li key={j} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={idx} className="list-decimal list-inside ml-2 space-y-1 my-2">
                {b.items.map((it, j) => (
                  <li key={j} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />
                ))}
              </ol>
            );
          case 'blockquote':
            return (
              <blockquote key={idx}
                          className="border-l-2 border-[var(--color-v4-red)] pl-3 py-1 my-3 italic text-[var(--color-v4-text-muted)]"
                          dangerouslySetInnerHTML={{ __html: renderInline(b.text) }} />
            );
          case 'code':
            return (
              <pre key={idx} className="bg-[var(--color-v4-surface)] rounded p-3 my-2 overflow-x-auto text-xs font-mono text-amber-300">
                <code>{b.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={idx} className="border-t border-[var(--color-v4-border)] my-4" />;
          case 'table':
            return (
              <div key={idx} className="overflow-x-auto my-3">
                <table className="w-full text-xs border border-[var(--color-v4-border)]">
                  <thead className="bg-[var(--color-v4-surface)]">
                    <tr>
                      {b.header.map((h, j) => (
                        <th key={j} className="px-3 py-2 text-left font-semibold text-white border-b border-[var(--color-v4-border)]"
                            dangerouslySetInnerHTML={{ __html: renderInline(h) }} />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j} className="border-b border-[var(--color-v4-border)]/40 last:border-b-0">
                        {row.map((c, k) => (
                          <td key={k} className="px-3 py-2 align-top"
                              dangerouslySetInnerHTML={{ __html: renderInline(c) }} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
};
