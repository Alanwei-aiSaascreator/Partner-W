import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSlidegenBlocks } from '../src/main/slidegen/blocks';
import type { SlideElement } from '../src/main/slidegen/dsl';
import { evaluateSlide } from '../src/main/slidegen/evaluate';
import { renderSlide } from '../src/main/slidegen/layout';

const skill = readFileSync(join(import.meta.dirname, '../our-skills/deck-layout/SKILL.md'), 'utf8').replace(
  /\r\n/g,
  '\n',
);

function elements(node: SlideElement): SlideElement[] {
  return node.children.filter(
    (child): child is SlideElement => typeof child === 'object' && child !== null && child.kind === 'element',
  );
}

function style(node: SlideElement): Record<string, unknown> {
  return (node.props.style ?? {}) as Record<string, unknown>;
}

function textOf(node: SlideElement): string {
  return node.children
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      return typeof child === 'object' && child?.kind === 'element' ? textOf(child) : '';
    })
    .join('')
    .trim();
}

function footerExample(): { page: SlideElement; footer: SlideElement } {
  for (const [, body] of skill.matchAll(/```slidegen\n([\s\S]*?)\n```/g)) {
    const { decks, failures } = extractSlidegenBlocks('```slidegen\n' + body + '\n```');
    expect(failures).toEqual([]);
    expect(decks).toHaveLength(1);
    for (const page of evaluateSlide(decks[0].source)) {
      const footer = elements(page).find((node) => node.tag === 'Box' && style(node).bottom !== undefined);
      if (footer) return { page, footer };
    }
  }
  throw new Error('The skill needs a complete executable slidegen example with a shared footer row');
}

describe('deck-layout footer reference contract', () => {
  it('keeps the note and counter in one row instead of competing absolute anchors', () => {
    const { page, footer } = footerExample();
    expect(style(page)).toMatchObject({ width: 1280, height: 720, position: 'relative' });
    expect(style(footer)).toMatchObject({
      position: 'absolute',
      left: 80,
      bottom: 28,
      width: 1120,
      flexDirection: 'row',
      alignItems: 'center',
    });
    expect(style(footer).gap).toBeGreaterThan(0);
    const children = elements(footer);
    expect(children).toHaveLength(2);
    const [note, counter] = children;
    expect(children.map((node) => node.tag)).toEqual(['Text', 'Text']);
    expect(style(note)).toMatchObject({ flex: 1, minWidth: 0 });
    expect(style(counter)).toMatchObject({ flexShrink: 0 });
    expect(textOf(note).length).toBeGreaterThan(0);
    expect(textOf(counter)).toMatch(/^\d+\s*\/\s*\d+$/);
    for (const node of children) {
      expect(style(node).position).not.toBe('absolute');
      expect(style(node).left).toBeUndefined();
      expect(style(node).bottom).toBeUndefined();
      expect(renderSlide(page).html).toContain(textOf(node));
    }
  });

  it('reserves a content region above the footer on the 1280 by 720 canvas', () => {
    const { page, footer } = footerExample();
    const footerStyle = style(footer);
    expect(footerStyle.height).toBeGreaterThan(0);
    const footerTop = Number(style(page).height) - Number(footerStyle.bottom) - Number(footerStyle.height);
    expect(footerTop).toBeGreaterThanOrEqual(660);
    const content = elements(page).filter((node) => node !== footer);
    expect(content.length).toBeGreaterThan(0);
    for (const region of content) {
      expect(region.tag).toBe('Box');
      expect(textOf(region).length).toBeGreaterThan(0);
      const regionStyle = style(region);
      expect(regionStyle.position).toBe('absolute');
      expect(regionStyle.top).toBeGreaterThanOrEqual(0);
      expect(regionStyle.height).toBeGreaterThan(0);
      expect(Number(regionStyle.top) + Number(regionStyle.height)).toBeLessThanOrEqual(footerTop - 20);
    }
  });

  it('uses solid footer text with readable contrast against the slide background', () => {
    const { page, footer } = footerExample();
    for (const node of elements(footer)) {
      const luminances = [style(node).color, style(page).background].map((color) => {
        expect(color).toMatch(/^#[\da-f]{6}$/i);
        const channels = String(color)
          .slice(1)
          .match(/../g)!
          .map((channel) => parseInt(channel, 16) / 255)
          .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      });
      expect((Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
