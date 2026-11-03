import { describe, it, expect } from 'vitest';
import { thesaurusPrompt, parseAiSenses, lookupSenses } from '../src/lib/thesaurus-ai.js';

describe('AI thesaurus', () => {
  it('asks for JSON senses of one word', () => {
    const p = thesaurusPrompt('happy');
    expect(p).toContain('happy');
    expect(p).toContain('"senses"');
    expect(p).toContain('synonyms');
    expect(p).toContain('antonyms');
  });

  it('reads senses out of a JSON reply, prose and code fences included', () => {
    const reply = 'Here you go:\n```json\n{"senses":[{"pos":"Adjective","meaning":"feeling pleasure","synonyms":["glad"," content ","glad"],"antonyms":["sad"]},{"pos":"noun","synonyms":[]}]}\n```';
    const senses = parseAiSenses(reply);
    expect(senses).toHaveLength(1);
    expect(senses[0].pos).toBe('adjective');
    expect(senses[0].gloss).toBe('feeling pleasure');
    expect(senses[0].synonyms).toEqual(['glad', 'content']);
    expect(senses[0].antonyms).toEqual(['sad']);
    expect(parseAiSenses('no json here')).toEqual([]);
    expect(parseAiSenses('{"senses":[{"pos":"noun"}]}')).toEqual([]);
  });

  it('uses the AI answer when a chat is configured', async () => {
    const seen = [];
    const { senses, lemma } = await lookupSenses('quick', {
      chat: async prompt => { seen.push(prompt); return { message: { content: '{"senses":[{"pos":"adjective","meaning":"moving fast","synonyms":["rapid","swift"],"antonyms":["slow"]}]}' } } },
      offline: async () => { throw new Error('local data must not be touched'); },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('quick');
    expect(lemma).toBeNull();
    expect(senses[0].synonyms).toEqual(['rapid', 'swift']);
  });

  it('falls back to the local data when the gateway fails, is unconfigured, or answers without senses', async () => {
    const local = { senses: [{ pos: 'adjective', gloss: 'sturdy', synonyms: ['solid'], antonyms: [] }], lemma: 'firm' };
    const offline = async () => local;
    const failure = await lookupSenses('firm', { chat: async () => { throw new Error('gateway 502: unreachable'); }, offline });
    expect(failure).toBe(local);
    expect(failure.senses[0].synonyms).toEqual(['solid']);
    const unconfigured = await lookupSenses('firm', { offline });
    expect(unconfigured).toBe(local);
    const empty = await lookupSenses('firm', { chat: async () => 'no json in this answer', offline });
    expect(empty).toBe(local);
  });
});
