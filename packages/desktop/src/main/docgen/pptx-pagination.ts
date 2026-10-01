import {
  BODY_HEIGHT_PT,
  MIN_BODY_PT,
  PptxLayoutError,
  estimateBodyHeightPt,
  findPptxLayoutProblem,
} from './pptx-layout.js';
import type { DocgenPptxRequest, DocgenSlide } from './request.js';

function fits(bullets: readonly string[]): boolean {
  return estimateBodyHeightPt(bullets, MIN_BODY_PT) <= BODY_HEIGHT_PT;
}

function splitBullet(bullet: string): string[] {
  if (fits([bullet])) return [bullet];
  const characters = Array.from(bullet);
  const parts: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = 1;
    let high = characters.length - offset;
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      if (fits([characters.slice(offset, offset + candidate).join('')])) low = candidate;
      else high = candidate - 1;
    }
    const remaining = characters.length - offset;
    let count = Math.ceil(remaining / Math.ceil(remaining / low));
    for (let index = count; index >= Math.ceil(count * 0.6); index -= 1) {
      if (/[\s,.!?;:\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]/u.test(characters[offset + index - 1])) {
        count = index;
        break;
      }
    }
    parts.push(characters.slice(offset, offset + count).join(''));
    offset += count;
  }
  return parts;
}

function paginateSlide(slide: DocgenSlide): DocgenSlide[] {
  const pages: DocgenSlide[] = [];
  let bullets: string[] = [];
  const flush = () => {
    pages.push({ title: slide.title, bullets, ...(pages.length === 0 && slide.notes ? { notes: slide.notes } : {}) });
    bullets = [];
  };
  for (const part of slide.bullets.flatMap(splitBullet)) {
    if (bullets.length > 0 && !fits([...bullets, part])) flush();
    bullets.push(part);
  }
  if (bullets.length > 0 || pages.length === 0) flush();
  return pages;
}

export function paginatePptxRequest(request: DocgenPptxRequest): DocgenPptxRequest {
  for (const [index, slide] of request.slides.entries()) {
    const problem = findPptxLayoutProblem({ ...request, slides: [slide] });
    if (problem && problem.code !== 'slide-body-overflow') {
      throw new PptxLayoutError('page' in problem ? { ...problem, page: index + 1 } : problem);
    }
  }
  return { ...request, slides: request.slides.flatMap(paginateSlide) };
}
