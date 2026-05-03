import { describe, expect, it } from 'vitest';
import { applyTextCase, konvaTextDecoration } from './textTransform';

describe('applyTextCase', () => {
  it('passes through for ORIGINAL / undefined / unknown', () => {
    expect(applyTextCase('Hello World', 'ORIGINAL')).toBe('Hello World');
    expect(applyTextCase('Hello World', undefined)).toBe('Hello World');
    expect(applyTextCase('Hello World', 'BOGUS')).toBe('Hello World');
  });

  it('UPPER → toUpperCase()', () => {
    expect(applyTextCase('hello', 'UPPER')).toBe('HELLO');
    expect(applyTextCase('Hello World', 'UPPER')).toBe('HELLO WORLD');
  });

  it('LOWER → toLowerCase()', () => {
    expect(applyTextCase('HELLO WORLD', 'LOWER')).toBe('hello world');
  });

  it('TITLE → first letter of each word capitalized, rest lowercase', () => {
    expect(applyTextCase('hello world', 'TITLE')).toBe('Hello World');
    expect(applyTextCase('HELLO WORLD', 'TITLE')).toBe('Hello World');
    expect(applyTextCase('mIxEd CaSe', 'TITLE')).toBe('Mixed Case');
  });

  it('TITLE preserves multiple spaces and punctuation', () => {
    expect(applyTextCase('hello, world!', 'TITLE')).toBe('Hello, World!');
    // Punctuation is part of the word in our regex — gets the same case
    // treatment (lowercased after the first character).
  });

  it('Korean / CJK is unchanged by UPPER/LOWER (no case mapping)', () => {
    expect(applyTextCase('안녕하세요', 'UPPER')).toBe('안녕하세요');
    expect(applyTextCase('안녕하세요', 'LOWER')).toBe('안녕하세요');
    expect(applyTextCase('안녕하세요', 'TITLE')).toBe('안녕하세요');
  });

  it('mixed Latin + Korean — Latin transformed, Korean kept', () => {
    expect(applyTextCase('hello 안녕', 'UPPER')).toBe('HELLO 안녕');
  });
});

describe('konvaTextDecoration', () => {
  it('maps Figma values', () => {
    expect(konvaTextDecoration('UNDERLINE')).toBe('underline');
    expect(konvaTextDecoration('STRIKETHROUGH')).toBe('line-through');
  });

  it('returns undefined for NONE / missing / unknown', () => {
    expect(konvaTextDecoration('NONE')).toBeUndefined();
    expect(konvaTextDecoration(undefined)).toBeUndefined();
    expect(konvaTextDecoration('foo' as never)).toBeUndefined();
  });
});
