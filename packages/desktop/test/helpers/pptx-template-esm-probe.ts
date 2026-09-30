import { fillTemplateDeck } from '../../src/main/docgen/pptx-template/fill.js';
import { parseTemplateDeck } from '../../src/main/docgen/pptx-template/parse.js';

const [, , templatesRoot, outputDir] = process.argv;
if (!templatesRoot || !outputDir) throw new Error('Template and output directories are required');
const parsed = parseTemplateDeck({
  template: 'business-deck-v4',
  slides: [
    { templateId: 'cover', data: { cover_title: 'Native ESM cover', cover_subtitle: 'Keep the designed template' } },
    { templateId: 'closing', data: { closing_title: 'Native ESM closing', closing_message: 'Editable delivery' } },
  ],
});
if (!parsed.ok) throw new Error(JSON.stringify(parsed.failure));
await fillTemplateDeck({ deck: parsed.deck, templatesRoot, outputDir, outputName: 'native-esm.pptx' });
