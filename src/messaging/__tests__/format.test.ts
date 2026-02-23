import { describe, it, expect } from 'vitest';
import { markdownToTelegramHtml, smartChunk } from '../format.js';

describe('markdownToTelegramHtml', () => {
  it('should escape HTML entities', () => {
    expect(markdownToTelegramHtml('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d');
  });

  it('should convert bold', () => {
    expect(markdownToTelegramHtml('**bold**')).toBe('<b>bold</b>');
  });

  it('should convert italic', () => {
    expect(markdownToTelegramHtml('*italic*')).toBe('<i>italic</i>');
  });

  it('should convert inline code', () => {
    expect(markdownToTelegramHtml('use `foo()` here')).toBe('use <code>foo()</code> here');
  });

  it('should convert code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre><code>const x = 1;</code></pre>');
  });

  it('should convert code blocks without language tag', () => {
    const input = '```\nhello\n```';
    expect(markdownToTelegramHtml(input)).toBe('<pre><code>hello</code></pre>');
  });

  it('should convert links', () => {
    expect(markdownToTelegramHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  it('should convert strikethrough', () => {
    expect(markdownToTelegramHtml('~~deleted~~')).toBe('<s>deleted</s>');
  });

  it('should handle nested bold and italic', () => {
    expect(markdownToTelegramHtml('***bold italic***')).toBe('<b><i>bold italic</i></b>');
  });

  it('should pass through plain text unchanged (except escaping)', () => {
    expect(markdownToTelegramHtml('hello world')).toBe('hello world');
  });

  it('should not convert underscores inside words', () => {
    expect(markdownToTelegramHtml('foo_bar_baz')).toBe('foo_bar_baz');
  });

  it('should handle empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });

  it('should escape HTML inside code spans', () => {
    expect(markdownToTelegramHtml('`<div>`')).toBe('<code>&lt;div&gt;</code>');
  });

  it('should escape HTML inside code blocks', () => {
    const input = '```\n<script>alert("xss")</script>\n```';
    expect(markdownToTelegramHtml(input)).toBe(
      '<pre><code>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</code></pre>'
    );
  });
});

describe('smartChunk', () => {
  it('should return single chunk for short text', () => {
    expect(smartChunk('hello', 4096)).toEqual(['hello']);
  });

  it('should split at paragraph boundary', () => {
    const a = 'a'.repeat(2000);
    const b = 'b'.repeat(2000);
    const text = `${a}\n\n${b}`;
    const chunks = smartChunk(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it('should split at line boundary when no paragraph break', () => {
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    const text = `${a}\n${b}`;
    const chunks = smartChunk(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it('should hard split when no newlines', () => {
    const text = 'x'.repeat(8192);
    const chunks = smartChunk(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(4096);
    expect(chunks[1].length).toBe(4096);
  });

  it('should handle empty input', () => {
    expect(smartChunk('', 4096)).toEqual(['']);
  });
});
