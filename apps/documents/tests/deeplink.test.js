// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseDeepLinkImport, MAX_DEEPLINK_BODY_CHARS } from '../src/lib/deeplink.js';

describe('parseDeepLinkImport', () => {
  it('returns null for plain routes and #/new without content', () => {
    expect(parseDeepLinkImport('#/new')).toBeNull();
    expect(parseDeepLinkImport('#/new?title=Notes')).toBeNull();
    expect(parseDeepLinkImport('#/edit/a.docx?body=x')).toBeNull();
    expect(parseDeepLinkImport('#/home')).toBeNull();
    expect(parseDeepLinkImport('')).toBeNull();
  });

  it('reads a markdown body with its title and source', () => {
    const parsed = parseDeepLinkImport('#/new?title=Design%20notes&body=%23%20Heading%0A%0AText&format=markdown&source=fusion-design');
    expect(parsed.name).toBe('Design notes');
    expect(parsed.payload).toEqual({ value: '# Heading\n\nText', type: 'markdown' });
    expect(parsed.source).toBe('fusion-design');
  });

  it('defaults to markdown and accepts the format aliases', () => {
    const def = parseDeepLinkImport('#/new?body=plain');
    expect(def.payload).toEqual({ value: 'plain', type: 'markdown' });
    for (const [format, type] of [['html', 'html'], ['text', 'text'], ['txt', 'text'], ['md', 'markdown'], ['PLAIN', 'text']]) {
      expect(parseDeepLinkImport(`#/new?body=x&format=${format}`).payload.type).toBe(type);
    }
  });

  it('treats name as a synonym of title and leaves the source short', () => {
    const parsed = parseDeepLinkImport(`#/new?name=Spec&body=x&source=${'s'.repeat(500)}`);
    expect(parsed.name).toBe('Spec');
    expect(parsed.source).toBe('s'.repeat(200));
  });

  it('routes html through the same cleanup a file import takes', () => {
    const parsed = parseDeepLinkImport('#/new?body=%3Chtml%3E%3Chead%3E%3Cstyle%3Ep%20%7B%7D%3C%2Fstyle%3E%3C%2Fhead%3E%3Cbody%3E%3Cp%3EHello%3C%2Fp%3E%3Cscript%3Ebad()%3C%2Fscript%3E%3C%2Fbody%3E%3C%2Fhtml%3E&format=html');
    expect(parsed.payload.type).toBe('html');
    expect(parsed.payload.value).not.toContain('script');
    expect(parsed.payload.value).toContain('<p>Hello</p>');
  });

  it('rejects a body past the size cap with an actionable error', () => {
    const body = 'x'.repeat(MAX_DEEPLINK_BODY_CHARS + 1);
    expect(() => parseDeepLinkImport(`#/new?body=${encodeURIComponent(body)}`)).toThrow(/too much content/);
  });
});
