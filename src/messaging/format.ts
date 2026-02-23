// src/messaging/format.ts
// Self-contained Markdown → Telegram HTML converter.
// Supports: bold, italic, bold-italic, code, code blocks, links, strikethrough.

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';

  // Extract code blocks first to protect them from inline formatting
  const codeBlocks: string[] = [];
  let text = markdown.replace(/```(?:\w*)\n?([\s\S]*?)```/g, (_match, code: string) => {
    const trimmed = code.replace(/\n$/, '');
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code>${escapeHtml(trimmed)}</code></pre>`);
    return placeholder;
  });

  // Extract inline code to protect from further processing
  const inlineCode: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const placeholder = `\x00IC${inlineCode.length}\x00`;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // Escape HTML in remaining text
  text = escapeHtml(text);

  // Bold+italic (***text***)
  text = text.replace(/\*{3}(.+?)\*{3}/g, '<b><i>$1</i></b>');

  // Bold (**text**)
  text = text.replace(/\*{2}(.+?)\*{2}/g, '<b>$1</b>');

  // Italic (*text*) — but not inside words
  text = text.replace(/(?<![a-zA-Z0-9])\*(.+?)\*(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // Strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore inline code
  text = text.replace(/\x00IC(\d+)\x00/g, (_match, idx: string) => inlineCode[parseInt(idx, 10)]);

  // Restore code blocks
  text = text.replace(/\x00CB(\d+)\x00/g, (_match, idx: string) => codeBlocks[parseInt(idx, 10)]);

  return text;
}

/**
 * Split text into chunks respecting Telegram's message size limit.
 * Prefers paragraph boundaries (\n\n) for cleaner message breaks.
 * Falls back to line boundaries, then hard splits at maxLength.
 */
export function smartChunk(text: string, maxLength: number): string[] {
  // Proactively split at paragraph boundaries when the text is near the limit.
  // This produces cleaner multi-message output for Telegram rather than sending
  // one giant message that's almost at the limit.
  if (text.length > maxLength * 0.75 && text.includes('\n\n')) {
    const paragraphs = text.split('\n\n');
    if (paragraphs.length > 1 && paragraphs.every((p) => p.length <= maxLength)) {
      return paragraphs;
    }
  }

  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const half = maxLength / 2;

    // Try paragraph boundary
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < half) {
      // Try line boundary
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt < half) {
      // Hard split
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  return chunks;
}
