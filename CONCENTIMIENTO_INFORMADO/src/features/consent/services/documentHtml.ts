import { ACR_LOGO_SVG } from '@/components/logos';
import {
  formatDocumentDateTime,
  formatTemplateDate,
} from '@/features/consent/services/documentDate';
import type {
  ConsentBlock,
  ConsentSubmission,
  ConsentTemplate,
} from '@/features/consent/types/consent';

const INDENT_STEP_PX = 24;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function indentStyle(indent?: number): string {
  const level = indent ?? 0;
  return level > 0 ? ` style="margin-left:${level * INDENT_STEP_PX}px"` : '';
}

/** The PDF counterpart of ConsentDocument.tsx — same blocks, print styling. */
export function blockToHtml(block: ConsentBlock): string {
  switch (block.type) {
    case 'heading': {
      const level = block.level ?? 1;
      return `<h${level + 1} class="h${level}">${escapeHtml(block.text)}</h${level + 1}>`;
    }
    case 'paragraph': {
      const emphasis = block.emphasis ? ` ${block.emphasis}` : '';
      return `<p class="body${emphasis}"${indentStyle(block.indent)}>${escapeHtml(block.text)}</p>`;
    }
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
      return `<${tag} class="body"${indentStyle(block.indent)}>${items}</${tag}>`;
    }
    case 'note':
      return `<div class="note">${escapeHtml(block.text)}</div>`;
    case 'spacer':
      return '<div class="spacer"></div>';
  }
}

/**
 * Masthead matching the paper form: logo | title | control metadata.
 * The printed FECHA is the template's own creation date — it identifies which
 * revision of the form this is, and stays fixed across every document produced
 * from it. The date of the consent act goes in the closing row instead.
 */
function headerToHtml(template: ConsentTemplate): string {
  // The SVG source is inlined directly. Unlike a bitmap it needs no base64
  // encoding and no asset read, so it cannot fail the way a file-backed logo
  // can, and it stays sharp at print resolution.
  const logoCell = `<div class="logo">${ACR_LOGO_SVG}</div>`;

  return `
    <table class="masthead">
      <tr>
        <td class="masthead-logo">${logoCell}</td>
        <td class="masthead-title">${escapeHtml(template.title.toUpperCase())}</td>
        <td class="masthead-meta">
          <div class="meta-line"><b>CODIGO:</b> ${escapeHtml(template.code)}</div>
          <div class="meta-line"><b>VERSIÓN:</b> ${escapeHtml(template.version)}</div>
          <div class="meta-line last"><b>FECHA:</b> ${escapeHtml(
            formatTemplateDate(template.effectiveDate)
          )}</div>
        </td>
      </tr>
    </table>`;
}

/** Patient data across the top — one horizontal strip, label above value. */
function fieldsToHtml(template: ConsentTemplate, submission: ConsentSubmission): string {
  if (template.fields.length === 0) return '';

  const width = (100 / template.fields.length).toFixed(2);
  const cells = template.fields
    .map(
      (field) => `
        <td class="pd-cell" style="width:${width}%">
          <div class="pd-label">${escapeHtml(field.label.toUpperCase())}</div>
          <div class="pd-value">${escapeHtml(submission.values[field.key] ?? '')}</div>
        </td>`
    )
    .join('');

  return `<table class="patient-data"><tr>${cells}</tr></table>`;
}

/** The closing strip: signatures, identifying data and the date, all in one row. */
function footerToHtml(template: ConsentTemplate, submission: ConsentSubmission): string {
  const width = (100 / template.footer.length).toFixed(2);

  const cells = template.footer
    .map((cell) => {
      let content = '';
      let label = '';

      if (cell.type === 'signature') {
        const slot = template.signatures.find((s) => s.key === cell.key);
        const dataUrl = submission.signatures[cell.key];
        content = dataUrl
          ? `<img class="fc-signature" src="${dataUrl}" alt="" />`
          : '<div class="fc-blank"></div>';
        label = slot?.label ?? '';
      } else if (cell.type === 'field') {
        const field = template.fields.find((f) => f.key === cell.key);
        content = `<div class="fc-text">${escapeHtml(submission.values[cell.key] ?? '')}</div>`;
        label = field?.label ?? '';
      } else {
        content = `<div class="fc-text">${escapeHtml(
          formatDocumentDateTime(submission.signedAt)
        )}</div>`;
        label = cell.label ?? 'Fecha y hora';
      }

      return `
        <td class="fc-cell" style="width:${width}%">
          ${content}
          <div class="fc-label">${escapeHtml(label)}</div>
        </td>`;
    })
    .join('');

  return `<table class="footer-row"><tr>${cells}</tr></table>`;
}

export function buildConsentHtml(
  template: ConsentTemplate,
  submission: ConsentSubmission
): string {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <style>
      @page { margin: 28px; }
      body { font-family: Helvetica, Arial, sans-serif; color: #12212b; }

      table.masthead { width: 100%; border-collapse: collapse; margin-bottom: 16px;
                       border: 1px solid #12212b; table-layout: fixed; }
      table.masthead td { border: 1px solid #12212b; vertical-align: middle; }
      .masthead-logo { width: 130px; text-align: center; padding: 6px; }
      .masthead-logo .logo { width: 118px; height: 52px; margin: 0 auto; }
      .masthead-logo .logo svg { width: 100%; height: 100%; }
      .masthead-title { text-align: center; font-size: 12px; font-weight: 700;
                        line-height: 1.35; padding: 8px 10px; }
      .masthead-meta { width: 150px; padding: 0; }
      .meta-line { font-size: 9px; padding: 4px 6px; border-bottom: 1px solid #12212b; }
      .meta-line.last { border-bottom: none; }

      .h1 { font-size: 13px; margin: 14px 0 6px; }
      .h2 { font-size: 12px; margin: 12px 0 4px; color: #0b5f66; }
      .h3 { font-size: 11px; margin: 10px 0 4px; color: #4e6870; }
      .body { font-size: 10.5px; line-height: 1.55; margin: 0 0 8px; text-align: justify; }
      ul.body, ol.body { padding-left: 18px; }
      ul.body li, ol.body li { margin-bottom: 4px; }
      .bold { font-weight: 700; }
      .italic { font-style: italic; }
      .note { font-size: 10.5px; line-height: 1.55; text-align: justify;
              border-left: 3px solid #0e7a82; background: #f2f8f8;
              padding: 8px 10px; margin: 12px 0; }
      .spacer { height: 10px; }

      table.patient-data { width: 100%; border-collapse: collapse; table-layout: fixed;
                           border: 1px solid #12212b; margin-bottom: 16px; }
      td.pd-cell { border: 1px solid #12212b; padding: 6px 10px; vertical-align: top; }
      .pd-label { font-size: 8px; font-weight: 700; letter-spacing: 0.06em;
                  color: #4e6870; margin-bottom: 3px; }
      .pd-value { font-size: 13px; font-weight: 700; color: #12212b;
                  line-height: 1.25; word-wrap: break-word; }

      table.footer-row { width: 100%; margin-top: 34px; border-collapse: collapse;
                         table-layout: fixed; }
      td.fc-cell { vertical-align: bottom; padding: 0 8px; }
      /* Everything in a footer cell centres over its ruled line. The signature
         image is cropped to the ink, so its aspect ratio varies per signer:
         bound it on both axes and let it scale, rather than pinning the height
         (which would squash a wide signature once max-width kicked in). */
      .fc-signature { max-height: 60px; max-width: 100%; width: auto; height: auto;
                      display: block; margin: 0 auto 4px; }
      .fc-blank { height: 60px; }
      /* Bottom-aligned via padding rather than flexbox: flex inside a table
         cell is unreliable in Android's print WebView. */
      .fc-text { min-height: 60px; padding-top: 42px; box-sizing: border-box;
                 font-size: 11px; font-weight: 700; color: #12212b;
                 word-wrap: break-word; text-align: center; }
      .fc-label { border-top: 1px solid #12212b; padding-top: 4px;
                  font-size: 9px; font-weight: 700; text-align: center; }
    </style>
  </head>
  <body>
    ${headerToHtml(template)}

    ${fieldsToHtml(template, submission)}

    ${template.blocks.map(blockToHtml).join('\n')}

    ${footerToHtml(template, submission)}
  </body>
</html>`;
}
