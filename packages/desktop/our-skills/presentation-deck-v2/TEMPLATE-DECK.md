# Fixed slot template contract

This contract is the single controlled route: enabled whenever ROYIN_NATIVE_PPT_VALIDATION=1 is set (the earlier business-deck-v5 trial is retired; the renderer keeps that branch only to revise previously generated v5 files). Production and legacy layouts are unchanged.

Use the supplied 16-layout template catalog as fixed. Read TEMPLATE-DECK-SLOTS.json for the exact ordered editable slots per layout, character and line limits, font sizes and chart requirements. Choose a nonempty subset through the existing content keys "1" to "16"; selected layouts appear once in natural catalog order. The keys identify layouts, not the final output page numbers. All 16 layouts remain available, but every task need not use all of them. Repetition and arbitrary ordering are not implemented. Do not invent facts to populate unavailable data.

Write one file ending .native-ppt.json:

```json
{
  "kind": "pptx",
  "template": "templateDeck",
  "title": "User requested title",
  "content": {
    "1": ["Each ordered slot receives one string"],
    "10": {
      "texts": ["All ordered text slots"],
      "chart": {
        "title": "A sourced chart title",
        "categories": ["Period"],
        "series": [{ "name": "Metric", "values": [10] }]
      }
    }
  }
}
```

The example is abbreviated: supply every editable slot on each selected layout from the slot table. Select layout 10 (bar chart) or 11 (line chart) only when supplied, sourced numerical data support that chart; otherwise omit those keys and choose text layouts. Selected chart layouts still require title, categories, series and finite values. Use only supplied, sourced units, category labels and conclusions. Existing values and chart data must remain stable during visual-only revisions. If required content does not fit the available layouts, return a capacity diagnostic for the executor; do not shrink fonts or silently omit sentences.

Use the installed deck-layout/scripts/generate.cjs with the trusted bundled Node executable. Preserve its receipt. For user revision pass --previous with the verified prior receipt. User revisions are distinct from the executor's bounded automatic correction rounds.

The final reply must use the exact generated filename and path returned in the generator receipt, including its hash suffix. Never substitute the requested title or a guessed shortened filename. The receipt's actual pages count and final-version checks describe the selected output, not the 16-layout catalog.

The renderer rejects missing slots, placeholder text, unsupported characters, excess text or line capacity, missing chart titles and invalid chart data. It never shrinks fonts or silently deletes content. New lines clone the original paragraph and run properties. Native chart caches and the editable embedded workbook are updated together.

Fonts use the approved template's explicit point sizes and static Source Han Sans SC / localized family 思源黑体. The host verifies bundled font hashes and performs first user-level Windows installation; missing font supply is a failure. Fonts are not embedded in PPTX.

File generation, structural/content/font checks, automatic visual review and Office/WPS acceptance are different states. Keep intermediate JSON and receipts outside formal user artifacts. A file remains needs-review until the actual final-version reviews complete.
