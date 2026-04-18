/**
 * ============================================
 * Resume Builder Service
 * ============================================
 * 
 * Generates optimized resume files in PDF and DOCX
 * formats using custom Markdown parsing.
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, ExternalHyperlink, TabStopType, UnderlineType } = require('docx');
const logger = require('../utils/logger');

const TEMP_DIR     = path.resolve(process.env.TEMP_DIR || './temp');
const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

// ── CUSTOM MARKDOWN PARSER ────────────────────────────────────────

function parseInline(text) {
  const tokens = [];
  const regex = /(\*\*.*?\*\*|\[.*?\]\(.*?\))/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    const tokenStr = match[0];
    if (tokenStr.startsWith('**')) {
      tokens.push({ type: 'bold', content: tokenStr.slice(2, -2) });
    } else if (tokenStr.startsWith('[')) {
      const closingBracket = tokenStr.indexOf(']');
      const linkText = tokenStr.slice(1, closingBracket);
      const url = tokenStr.slice(closingBracket + 2, -1);
      tokens.push({ type: 'link', text: linkText, url: url });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ type: 'text', content: text.slice(lastIndex) });
  }
  return tokens;
}

function parseMarkdownNodes(text) {
  const lines = text.split('\n');
  const doc = { name: '', contact: '', sections: [] };
  let currentSection = null;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    if (line.startsWith('# ')) {
      doc.name = line.substring(2).trim();
    } else if (line.startsWith('## ')) {
      currentSection = { title: line.substring(3).trim(), items: [] };
      doc.sections.push(currentSection);
    } else if (line.startsWith('### ')) {
      const content = line.substring(4).trim();
      let left = content, right = '';
      if (content.includes('||')) {
        const parts = content.split('||');
        left = parts[0].trim();
        right = parts[1].trim();
      }
      if (currentSection) {
        currentSection.items.push({ type: 'subheading', left, right });
      }
    } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      const content = line.replace(/^[\-\*\•]\s*/, '').trim();
      if (currentSection) {
        currentSection.items.push({ type: 'bullet', content });
      }
    } else {
      if (currentSection) {
        currentSection.items.push({ type: 'paragraph', content: line });
      } else {
        if (!doc.contact && doc.name) {
          doc.contact = line;
        } else if (!doc.name) {
          doc.name = line; // fallback
        } else {
          doc.contact += ' | ' + line;
        }
      }
    }
  }
  return doc;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateInlineHtml(text) {
  const tokens = parseInline(text);
  let html = '';
  for (const t of tokens) {
    if (t.type === 'bold') {
      if (t.content.includes(':')) {
         html += `<span class="bold-blue">${escapeHtml(t.content)}</span>`;
      } else {
         html += `<strong>${escapeHtml(t.content)}</strong>`;
      }
    } else if (t.type === 'link') {
      html += `<a href="${escapeHtml(t.url)}">${escapeHtml(t.text)}</a>`;
    } else {
      let tHtml = escapeHtml(t.content);
      // Replace standalone pipes outside links 
      tHtml = tHtml.replace(/\|/g, '<span style="margin: 0 4px; color: #1a365d;">|</span>');
      html += tHtml;
    }
  }
  return html;
}

// ── HTML & PDF ──────────────────────────────────────────────────

function buildHTML(resumeText, analysis = {}) {
  const templatePath = path.join(TEMPLATE_DIR, 'resumeTemplate.html');
  let html = fs.readFileSync(templatePath, 'utf-8');

  const ast = parseMarkdownNodes(resumeText);
  let bodyContent = '';

  bodyContent += `<h1 class="name">${generateInlineHtml(ast.name)}</h1>`;
  
  if (ast.contact) {
    const contactParts = ast.contact.split('|').map(p => p.trim());
    const mid = Math.ceil(contactParts.length / 2);
    const leftContact = contactParts.slice(0, mid).join(' | ');
    const rightContact = contactParts.slice(mid).join(' | ');
    bodyContent += `<div class="contact-info">
      <div>${generateInlineHtml(leftContact)}</div>
      <div>${generateInlineHtml(rightContact)}</div>
    </div>`;
  }

  for (const section of ast.sections) {
    bodyContent += `<div class="section">
      <h2 class="section-title">${generateInlineHtml(section.title)}</h2>
      <div class="section-content">`;
    
    for (const item of section.items) {
      if (item.type === 'subheading') {
        bodyContent += `<div class="subheading-row">
            <span class="subheading-left">${generateInlineHtml(item.left)}</span>
            <span class="subheading-right">${generateInlineHtml(item.right)}</span>
          </div>`;
      } else if (item.type === 'bullet') {
        bodyContent += `<div class="bullet-item">${generateInlineHtml(item.content)}</div>`;
      } else if (item.type === 'paragraph') {
        bodyContent += `<p>${generateInlineHtml(item.content)}</p>`;
      }
    }
    bodyContent += `</div></div>`;
  }

  html = html.replace('{{RESUME_CONTENT}}', bodyContent);
  html = html.replace('{{SCORE}}', analysis.compositeScore || 'N/A');

  return html;
}

async function generatePDF(resumeText, analysis = {}) {
  const html     = buildHTML(resumeText, analysis);
  const filename = `improved_resume_${uuidv4().slice(0, 8)}.pdf`;
  const filePath = path.join(TEMP_DIR, filename);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    await page.pdf({
      path: filePath,
      format: 'A4',
      margin: { top: '0.4in', right: '0.5in', bottom: '0.4in', left: '0.5in' },
      printBackground: true,
    });

    logger.info(`Generated PDF: ${filePath}`);
    return filePath;
  } catch (err) {
    logger.error(`PDF generation failed: ${err.message}`);
    throw new Error(`Could not generate PDF: ${err.message}`);
  } finally {
    if (browser) await browser.close();
  }
}

// ── DOCX GENERATOR ──────────────────────────────────────────────

function generateInlineDocx(text, defaultColor = '000000', defaultSize = 22, isBoldBlueOption = false) {
  const tokens = parseInline(text);
  const runs = [];
  
  for (const t of tokens) {
    if (t.type === 'bold') {
      const color = (isBoldBlueOption && t.content.includes(':')) ? '1a365d' : defaultColor;
      runs.push(new TextRun({ text: t.content, bold: true, size: defaultSize, color, font: 'Calibri' }));
    } else if (t.type === 'link') {
      runs.push(new ExternalHyperlink({
        children: [
          new TextRun({ text: t.text, size: defaultSize, color: '0000EE', underline: { type: UnderlineType.SINGLE }, font: 'Calibri' })
        ],
        link: t.url
      }));
    } else {
      runs.push(new TextRun({ text: t.content, size: defaultSize, color: defaultColor, font: 'Calibri' }));
    }
  }
  return runs;
}

async function generateDOCX(resumeText, analysis = {}) {
  const filename = `improved_resume_${uuidv4().slice(0, 8)}.docx`;
  const filePath = path.join(TEMP_DIR, filename);

  try {
    const ast = parseMarkdownNodes(resumeText);
    const docChildren = [];

    // Header - Name
    if (ast.name) {
      docChildren.push(new Paragraph({
        children: generateInlineDocx(ast.name, '1a365d', 36),
        spacing: { after: 60 }
      }));
    }

    // Header - Contact
    if (ast.contact) {
       const contactParts = ast.contact.split('|').map(p => p.trim());
       const mid = Math.ceil(contactParts.length / 2);
       const leftContact = contactParts.slice(0, mid).join(' | ');
       const rightContact = contactParts.slice(mid).join(' | ');
       
       docChildren.push(new Paragraph({
         children: [
           ...generateInlineDocx(leftContact + " \t ", '000000', 20),
           ...generateInlineDocx(rightContact, '000000', 20)
         ],
         tabStops: [{ type: TabStopType.RIGHT, position: 10000 }],
         spacing: { after: 200 }
       }));
    }

    // Sections
    for (const section of ast.sections) {
      docChildren.push(new Paragraph({
        children: generateInlineDocx(section.title.toUpperCase(), '1a365d', 24),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
        border: {
          bottom: { color: '1a365d', size: 1, style: BorderStyle.SINGLE, space: 1 }
        }
      }));

      for (const item of section.items) {
        if (item.type === 'subheading') {
           const subLeft = generateInlineDocx(item.left, '1a365d', 22, false);
           subLeft.forEach(run => run.bold = true);
           
           docChildren.push(new Paragraph({
             children: [
               ...subLeft,
               new TextRun({ text: '\t' }),
               ...generateInlineDocx(item.right, '000000', 20)
             ],
             tabStops: [{ type: TabStopType.RIGHT, position: 10000 }],
             spacing: { after: 60 }
           }));
        } else if (item.type === 'bullet') {
           docChildren.push(new Paragraph({
             children: generateInlineDocx(item.content, '000000', 20, true),
             bullet: { level: 0 },
             spacing: { after: 60 }
           }));
        } else if (item.type === 'paragraph') {
           docChildren.push(new Paragraph({
             children: generateInlineDocx(item.content, '000000', 20, true),
             spacing: { after: 60 }
           }));
        }
      }
    }

    const doc = new Document({
      sections: [{
        properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
        children: docChildren,
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);

    logger.info(`Generated DOCX: ${filePath}`);
    return filePath;
  } catch (err) {
    logger.error(`DOCX generation failed: ${err.message}`);
    throw new Error(`Could not generate DOCX: ${err.message}`);
  }
}

module.exports = {
  generatePDF,
  generateDOCX,
  buildHTML,
};
