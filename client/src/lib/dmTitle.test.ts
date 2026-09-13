import { describe, expect, it } from 'vitest';

import { dmCompanions, dmTitleFor } from './dmTitle';

const mara = { id: '1', username: 'mara', discriminator: 0 };
const renquist = { id: '2', username: 'renquist', discriminator: 0 };
const priya = { id: '3', username: 'priya', display_name: 'Priya', discriminator: 0 };

describe('what a conversation is called', () => {
  it('leaves the viewer out of their own group conversation', () => {
    // From mara's own view this read "mara, renquist".
    const group = { recipients: [mara, renquist] };
    expect(dmTitleFor(group, mara.id)).toBe('renquist');
    expect(dmTitleFor(group, renquist.id)).toBe('mara');
  });

  it('names everybody else, in the order the channel gave them', () => {
    const group = { recipients: [mara, renquist, priya] };
    expect(dmTitleFor(group, mara.id)).toBe('renquist, Priya');
    expect(dmCompanions(group, mara.id).map((p) => p.id)).toEqual(['2', '3']);
  });

  it('keeps an operator-set name whoever is looking', () => {
    expect(dmTitleFor({ name: 'Shop talk', recipients: [mara, renquist] }, mara.id)).toBe('Shop talk');
  });

  it('handles a one-to-one channel that carries a single recipient', () => {
    expect(dmTitleFor({ recipient: renquist }, mara.id)).toBe('renquist');
  });

  it('says so when nobody else is left, rather than naming you', () => {
    expect(dmTitleFor({ recipients: [mara] }, mara.id)).toBe('Just you');
    expect(dmTitleFor({ recipients: [mara] }, mara.id, 'Direct message')).toBe('Direct message');
  });

  it('names everyone when it does not know who is looking', () => {
    expect(dmTitleFor({ recipients: [mara, renquist] }, null)).toBe('mara, renquist');
  });
});
