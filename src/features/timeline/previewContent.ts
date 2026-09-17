import type { ConversationMessage } from '@/platform/chatgpt/conversation';

export function messageText(message: ConversationMessage) {
  if (!['text', 'multimodal_text'].includes(message.content.content_type)) return '';
  return Array.isArray(message.content.parts)
    ? message.content.parts.filter((part): part is string => typeof part === 'string').join('\n')
    : typeof message.content.text === 'string' ? message.content.text : '';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function records(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown) { return typeof value === 'string' ? value : ''; }

// ChatGPT also emits TeX delimiters. Do not rewrite examples inside code fences or spans.
function normalizeMath(markdown: string) {
  const tokens = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)|(`+)|\\([([])/gm;
  let result = '';
  let cursor = 0;
  for (let match = tokens.exec(markdown); match; match = tokens.exec(markdown)) {
    const start = match.index;
    result += markdown.slice(cursor, start);
    let end = tokens.lastIndex;
    if (match[1]) {
      const fence = match[1];
      const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n|$)`, 'gm');
      closing.lastIndex = end;
      const close = closing.exec(markdown);
      end = close ? closing.lastIndex : markdown.length;
      result += markdown.slice(start, end);
    } else if (match[2]) {
      const closing = new RegExp(`(?<!\x60)\x60{${match[2].length}}(?!\x60)`, 'g');
      closing.lastIndex = end;
      const close = closing.exec(markdown);
      end = close ? closing.lastIndex : end;
      result += markdown.slice(start, end);
    } else {
      const block = match[3] === '[';
      const close = markdown.indexOf(block ? '\\]' : '\\)', end);
      if (close < 0) result += match[0];
      else {
        const formula = markdown.slice(end, close);
        result += block ? `\n$$\n${formula}\n$$\n` : `$$${formula}$$`;
        end = close + 2;
      }
    }
    cursor = end;
    tokens.lastIndex = end;
  }
  return result + markdown.slice(cursor);
}

export function getPreviewContent(message: ConversationMessage, sourceLabel: string, imageLabel: string) {
  const source = messageText(message);
  const references: { label: string; kind: 'mention' | 'source' }[] = [];
  const replacements: { start: number; end: number; index: number }[] = [];
  const addReference = (start: unknown, end: unknown, label: string, kind: 'mention' | 'source') => {
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end <= start || end > source.length) return;
    replacements.push({ start, end, index: references.length });
    references.push({ label, kind });
  };
  const serialization = record(message.metadata.serialization_metadata);
  for (const symbol of records(serialization.custom_symbol_offsets)) {
    if (typeof symbol.startIndex !== 'number' || typeof symbol.endIndex !== 'number') continue;
    addReference(symbol.startIndex, symbol.endIndex, source.slice(symbol.startIndex, symbol.endIndex), 'mention');
  }
  for (const reference of records(message.metadata.content_references)) {
    const labels = records(reference.items).map(item => text(item.title) || text(item.url)).filter(Boolean);
    const label = text(reference.title) || labels.join(' · ') || text(reference.alt) || sourceLabel;
    // Offsets belong to the original message, before trimming or Markdown conversion.
    if (typeof reference.matched_text === 'string' && typeof reference.start_idx === 'number' &&
        typeof reference.end_idx === 'number' && source.slice(reference.start_idx, reference.end_idx) !== reference.matched_text) continue;
    addReference(reference.start_idx, reference.end_idx, label, 'source');
  }
  let markdown = '';
  let cursor = 0;
  for (const replacement of replacements.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (replacement.start < cursor) continue;
    markdown += source.slice(cursor, replacement.start) + `:previewReference[${replacement.index}]`;
    cursor = replacement.end;
  }
  markdown += source.slice(cursor);

  const attachments = records(message.metadata.attachments).map(attachment => ({
    name: text(attachment.name), type: text(attachment.mime_type),
  })).filter(attachment => attachment.name);
  const images = records(message.content.parts).filter(part => part.content_type === 'image_asset_pointer').map(part => ({
    // Asset pointers require a separate authenticated resolution API; never use them as image URLs.
    src: /^https:\/\//i.test(text(part.asset_pointer)) ? text(part.asset_pointer) : undefined,
    alt: imageLabel,
  }));
  return { markdown: normalizeMath(markdown), references, attachments, images };
}
