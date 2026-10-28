import path from 'node:path';
import type { SlideChild } from './dsl.js';

export function imageNames(nodes: readonly SlideChild[]): string[] {
  const names = new Set<string>();
  const visit = (node: SlideChild) => {
    if (!node || typeof node !== 'object' || node.kind !== 'element') return;
    if (node.tag === 'Image') {
      let src: string;
      try {
        if (typeof node.props.src !== 'string') throw new Error('invalid image');
        src = decodeURIComponent(node.props.src);
      } catch {
        throw new Error('resource-source-invalid');
      }
      if (/^[\\/]|^[a-z]+:/i.test(src) || src.split(/[\\/]/).includes('..')) throw new Error('resource-source-invalid');
      const name = path.basename(src);
      names.add(name);
      node.props.src = encodeURIComponent(name);
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return [...names].sort();
}
