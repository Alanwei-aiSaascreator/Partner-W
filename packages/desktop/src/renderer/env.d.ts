declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.webp' {
  const src: string;
  export default src;
}

declare module '*.md?raw' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly VITE_ADMIN_CONSOLE_URL?: string;
  readonly VITE_INTERNAL_BETA_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /**
   * Vite 的 `import.meta.glob`（本仓没有引 `vite/client`，只补用到的这一种重载）。
   * 用途：`lib/portrait-artwork.ts` 按文件名约定收集六张立绘 —— 素材还没放进来时
   * 返回空表（走占位降级），放进来即自动生效，不需要改 import 列表。
   */
  glob(pattern: string, options: { eager: true; query: '?url'; import: 'default' }): Record<string, string>;
}
