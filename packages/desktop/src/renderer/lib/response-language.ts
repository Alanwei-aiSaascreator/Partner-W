const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  pt: 'Portuguese',
  de: 'German',
  es: 'Spanish',
  fr: 'French',
};

export function buildResponseLanguageContext(locale: string): string {
  const normalized = locale.trim().toLowerCase().replaceAll('_', '-');
  const language = /^zh-(?:tw|hk|hant)(?:-|$)/.test(normalized)
    ? 'Traditional Chinese'
    : /^zh(?:-|$)/.test(normalized)
      ? 'Simplified Chinese'
      : (LANGUAGE_NAMES[normalized.split('-')[0]] ?? "the user's language");
  return [
    '<response-language>',
    `Default response language: ${language}.`,
    'Use this language for replies and visible text in generated pages, documents, and presentations, including titles, headings, labels, and explanations.',
    'If the user explicitly requests another language or a translation, that request takes priority for the requested content.',
    'Preserve code, identifiers, proper names, and quoted source text unless translation is requested. Do not translate protocol keys or tool arguments that require exact identifiers.',
    '</response-language>',
  ].join('\n');
}
