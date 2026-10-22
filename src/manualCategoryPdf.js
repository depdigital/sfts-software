import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';

const COLORS = Object.freeze({
  navy: '#102A43',
  blue: '#1769AA',
  paleBlue: '#EAF3FA',
  paleGold: '#FFF5D6',
  paleSilver: '#EEF2F6',
  paleBronze: '#F8E4D5',
  ink: '#17212B',
  muted: '#5D6B78',
  line: '#CBD5DF',
  white: '#FFFFFF'
});

const PAGE_MARGIN = 36;
const PAGE_BOTTOM = 38;
const FONT_CANDIDATES = Object.freeze([
  {
    regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
  },
  {
    regular: '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'
  },
  {
    regular: 'C:\\Windows\\Fonts\\arial.ttf',
    bold: 'C:\\Windows\\Fonts\\arialbd.ttf'
  }
]);

function text(value, fallback = '-') {
  const normalized = String(value ?? '').trim()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\u00b7/g, ' - ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return normalized || fallback;
}

function dateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return text(value);
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata'
  }).format(date);
}

function clockTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function participantKey(player) {
  if (!player?.playerName) return '';
  return `${String(player.playerName).trim().toUpperCase()}|${String(player.club || '').trim().toUpperCase()}`;
}

function collectParticipants(records, placements) {
  const participants = new Map();
  for (const record of records) {
    const counted = new Set();
    for (const player of [record.red, record.blue]) {
      const key = participantKey(player);
      if (!key) continue;
      if (!participants.has(key)) {
        participants.set(key, {
          key,
          playerName: text(player.playerName),
          club: text(player.club),
          stateCode: text(player.stateCode),
          district: text(player.district),
          boutCount: 0
        });
      }
      if (!counted.has(key)) {
        participants.get(key).boutCount += 1;
        counted.add(key);
      }
    }
  }

  const labels = new Map([
    [placements.gold?.key, 'GOLD'],
    [placements.silver?.key, 'SILVER'],
    [placements.bronze1?.key, 'BRONZE 1'],
    [placements.bronze2?.key, 'BRONZE 2']
  ].filter(([key]) => key));
  const order = { GOLD: 0, SILVER: 1, 'BRONZE 1': 2, 'BRONZE 2': 3 };
  return [...participants.values()]
    .map(participant => ({ ...participant, placement: labels.get(participant.key) || '-' }))
    .sort((left, right) => (order[left.placement] ?? 4) - (order[right.placement] ?? 4)
      || left.playerName.localeCompare(right.playerName)
      || left.club.localeCompare(right.club));
}

function roundWins(record) {
  const wins = { RED: 0, BLUE: 0 };
  for (const round of record.rounds || []) {
    if (round.winner === 'RED') wins.RED += 1;
    if (round.winner === 'BLUE') wins.BLUE += 1;
  }
  return `${wins.RED}-${wins.BLUE}`;
}

function roundScores(record) {
  return (record.rounds || [])
    .map(round => `R${round.round}: ${round.red?.score ?? 0}-${round.blue?.score ?? 0}`)
    .join('; ') || '-';
}

function resultCode(reason) {
  return /^[A-Z]+/.exec(String(reason || ''))?.[0] || '-';
}

function configureFonts(doc) {
  const candidate = FONT_CANDIDATES.find(item => existsSync(item.regular) && existsSync(item.bold));
  if (!candidate) return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
  doc.registerFont('SFTS-Regular', candidate.regular);
  doc.registerFont('SFTS-Bold', candidate.bold);
  return { regular: 'SFTS-Regular', bold: 'SFTS-Bold' };
}

function addPage(doc, fonts, { layout = 'portrait', heading = '', subheading = '' } = {}) {
  doc.addPage({
    size: 'A4',
    layout,
    margins: { top: 38, right: PAGE_MARGIN, bottom: PAGE_BOTTOM, left: PAGE_MARGIN }
  });
  doc.rect(0, 0, doc.page.width, 26).fill(COLORS.navy);
  doc.font(fonts.bold).fontSize(10).fillColor(COLORS.white)
    .text('SFTS - STRIKE FORCE TAEKWONDO SCORING', PAGE_MARGIN, 8, {
      width: doc.page.width - PAGE_MARGIN * 2,
      align: 'center',
      lineBreak: false
    });
  doc.y = 40;
  if (heading) {
    doc.font(fonts.bold).fontSize(layout === 'landscape' ? 15 : 17).fillColor(COLORS.navy)
      .text(text(heading), { align: 'center' });
  }
  if (subheading) {
    doc.moveDown(0.15).font(fonts.regular).fontSize(8).fillColor(COLORS.muted)
      .text(text(subheading), { align: 'center' });
  }
  doc.moveDown(0.65);
}

function ensureSpace(doc, fonts, height, pageOptions) {
  if (doc.y + height <= doc.page.height - PAGE_BOTTOM) return;
  addPage(doc, fonts, pageOptions);
}

function sectionTitle(doc, fonts, title, pageOptions) {
  ensureSpace(doc, fonts, 30, pageOptions);
  doc.moveDown(0.35);
  const y = doc.y;
  doc.rect(PAGE_MARGIN, y, doc.page.width - PAGE_MARGIN * 2, 20).fill(COLORS.paleBlue);
  doc.font(fonts.bold).fontSize(9).fillColor(COLORS.navy)
    .text(text(title), PAGE_MARGIN + 7, y + 6, { lineBreak: false });
  doc.y = y + 27;
}

function drawInfoGrid(doc, fonts, items, columns, pageOptions) {
  const gap = 6;
  const available = doc.page.width - PAGE_MARGIN * 2;
  const width = (available - gap * (columns - 1)) / columns;
  const rowHeight = 36;
  for (let index = 0; index < items.length; index += columns) {
    ensureSpace(doc, fonts, rowHeight + gap, pageOptions);
    const y = doc.y;
    for (let column = 0; column < columns; column += 1) {
      const item = items[index + column];
      if (!item) continue;
      const x = PAGE_MARGIN + column * (width + gap);
      doc.roundedRect(x, y, width, rowHeight, 3).fillAndStroke('#F7F9FB', COLORS.line);
      doc.font(fonts.bold).fontSize(6.5).fillColor(COLORS.muted)
        .text(text(item.label), x + 6, y + 6, { width: width - 12, lineBreak: false });
      doc.font(fonts.regular).fontSize(8).fillColor(COLORS.ink)
        .text(text(item.value), x + 6, y + 17, { width: width - 12, height: 14, ellipsis: true });
    }
    doc.y = y + rowHeight + gap;
  }
}

function drawPlacements(doc, fonts, placements, pageOptions) {
  const cards = [
    { label: 'GOLD', value: placements.gold, fill: COLORS.paleGold },
    { label: 'SILVER', value: placements.silver, fill: COLORS.paleSilver },
    { label: 'BRONZE 1', value: placements.bronze1, fill: COLORS.paleBronze },
    { label: 'BRONZE 2', value: placements.bronze2, fill: COLORS.paleBronze }
  ];
  const gap = 8;
  const width = (doc.page.width - PAGE_MARGIN * 2 - gap) / 2;
  const height = 42;
  for (let index = 0; index < cards.length; index += 2) {
    ensureSpace(doc, fonts, height + gap, pageOptions);
    const y = doc.y;
    for (let column = 0; column < 2; column += 1) {
      const card = cards[index + column];
      const x = PAGE_MARGIN + column * (width + gap);
      doc.roundedRect(x, y, width, height, 4).fillAndStroke(card.fill, COLORS.line);
      doc.font(fonts.bold).fontSize(7).fillColor(COLORS.muted)
        .text(card.label, x + 8, y + 7, { lineBreak: false });
      const value = card.value
        ? `${text(card.value.playerName)}${card.value.club ? ` - ${text(card.value.club)}` : ''}`
        : 'NOT AWARDED';
      doc.font(fonts.bold).fontSize(9).fillColor(COLORS.ink)
        .text(value, x + 8, y + 20, { width: width - 16, height: 16, ellipsis: true });
    }
    doc.y = y + height + gap;
  }
}

function tableRowHeight(doc, fonts, cells, widths, fontSize, bold = false) {
  doc.font(bold ? fonts.bold : fonts.regular).fontSize(fontSize);
  return Math.max(18, ...cells.map((cell, index) => (
    doc.heightOfString(text(cell), { width: widths[index] - 8, lineGap: 0 }) + 8
  )));
}

function drawTableRow(doc, fonts, cells, widths, y, height, { header = false, shaded = false, fontSize = 7 } = {}) {
  let x = PAGE_MARGIN;
  for (let index = 0; index < cells.length; index += 1) {
    const width = widths[index];
    doc.rect(x, y, width, height)
      .fillAndStroke(header ? COLORS.navy : shaded ? '#F6F8FA' : COLORS.white, COLORS.line);
    doc.font(header ? fonts.bold : fonts.regular).fontSize(fontSize)
      .fillColor(header ? COLORS.white : COLORS.ink)
      .text(text(cells[index]), x + 4, y + 4, {
        width: width - 8,
        height: height - 8,
        ellipsis: true,
        align: index === 0 ? 'center' : 'left'
      });
    x += width;
  }
}

function drawTable(doc, fonts, { headers, rows, widths, pageOptions, fontSize = 7 }) {
  const drawHeader = () => {
    const height = tableRowHeight(doc, fonts, headers, widths, fontSize, true);
    drawTableRow(doc, fonts, headers, widths, doc.y, height, { header: true, fontSize });
    doc.y += height;
  };
  ensureSpace(doc, fonts, 40, pageOptions);
  drawHeader();
  const values = rows.length ? rows : [headers.map((_, index) => index === 0 ? 'NO RECORDS' : '')];
  values.forEach((row, index) => {
    const height = tableRowHeight(doc, fonts, row, widths, fontSize);
    if (doc.y + height > doc.page.height - PAGE_BOTTOM) {
      addPage(doc, fonts, pageOptions);
      drawHeader();
    }
    drawTableRow(doc, fonts, row, widths, doc.y, height, { shaded: index % 2 === 1, fontSize });
    doc.y += height;
  });
  doc.moveDown(0.65);
}

function drawSignatures(doc, fonts, pageOptions) {
  ensureSpace(doc, fonts, 70, pageOptions);
  doc.moveDown(1.6);
  const labels = ['TECHNICAL OFFICIAL', 'ARENA INCHARGE', 'ORGANIZER'];
  const gap = 24;
  const width = (doc.page.width - PAGE_MARGIN * 2 - gap * 2) / 3;
  const y = doc.y + 24;
  labels.forEach((label, index) => {
    const x = PAGE_MARGIN + index * (width + gap);
    doc.moveTo(x, y).lineTo(x + width, y).strokeColor(COLORS.ink).lineWidth(0.7).stroke();
    doc.font(fonts.bold).fontSize(7).fillColor(COLORS.ink)
      .text(label, x, y + 7, { width, align: 'center' });
  });
  doc.y = y + 30;
}

function addPageFooters(doc, fonts, generatedAt) {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const y = doc.page.height - 28;
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(PAGE_MARGIN, y - 5).lineTo(doc.page.width - PAGE_MARGIN, y - 5)
      .strokeColor(COLORS.line).lineWidth(0.5).stroke();
    doc.font(fonts.regular).fontSize(6.5).fillColor(COLORS.muted)
      .text(`Generated ${dateTime(generatedAt)}`, PAGE_MARGIN, y, {
        width: (doc.page.width - PAGE_MARGIN * 2) / 2,
        lineBreak: false
      });
    doc.text(`Page ${index - range.start + 1} of ${range.count}`, doc.page.width / 2, y, {
      width: doc.page.width / 2 - PAGE_MARGIN,
      align: 'right',
      lineBreak: false
    });
    doc.page.margins.bottom = originalBottomMargin;
  }
}

function normalizedOptions(options) {
  const includeFullAudit = options?.includeFullAudit === true;
  return {
    includeBoutSummary: options?.includeBoutSummary !== false,
    includeFullAudit,
    includeCornerRefereeHistory: includeFullAudit && options?.includeCornerRefereeHistory === true
  };
}

export function manualCategoryPdfFileName(category, generatedAt = new Date()) {
  const date = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  const stamp = Number.isNaN(date.valueOf())
    ? 'undated'
    : date.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const identity = [
    category?.divisionLabel || category?.division,
    category?.gender,
    category?.categoryGroup || category?.weightCategory
  ].map(value => text(value, 'category'))
    .join('_')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90) || 'category';
  return `SFTS_Category_Result_${identity}_${stamp}.pdf`;
}

export function createManualCategoryPdf({ category, records = [], options = {}, generatedAt = new Date().toISOString() }) {
  if (!category || typeof category !== 'object') throw new Error('Manual category is required');
  if (!Array.isArray(records)) throw new Error('Manual category records must be an array');
  const reportOptions = normalizedOptions(options);
  const sortedRecords = [...records].sort((left, right) => (
    String(left.endedAt || '').localeCompare(String(right.endedAt || ''))
  ));
  const placements = category.placements && Object.values(category.placements).some(Boolean)
    ? category.placements
    : category.calculatedPlacements || {};
  const participants = collectParticipants(sortedRecords, placements);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, compress: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const fonts = configureFonts(doc);
    doc.info.Title = `${text(category.eventName)} - Official Category Result`;
    doc.info.Author = 'SFTS - Strike Force Taekwondo Scoring';
    doc.info.Subject = `${text(category.divisionLabel || category.division)} ${text(category.gender)} ${text(category.categoryGroup || category.weightCategory)}`;
    doc.info.CreationDate = new Date(generatedAt);

    const title = 'OFFICIAL CATEGORY RESULT';
    const identity = [
      category.divisionLabel || category.division,
      category.gender,
      category.categoryGroup || category.weightCategory
    ].map(value => text(value)).join(' - ');
    const portraitPage = { layout: 'portrait', heading: title, subheading: identity };
    addPage(doc, fonts, portraitPage);
    doc.font(fonts.bold).fontSize(14).fillColor(COLORS.blue)
      .text(text(category.eventName), { align: 'center' });
    doc.moveDown(0.7);

    drawInfoGrid(doc, fonts, [
      { label: 'DATE', value: category.eventDate },
      { label: 'VENUE', value: category.venue },
      { label: 'ARENA', value: category.arenaNumber },
      { label: 'COMPETITION', value: category.competition },
      { label: 'DIVISION', value: category.divisionLabel || category.division },
      { label: 'GENDER', value: category.gender },
      { label: 'CATEGORY', value: category.categoryGroup || category.weightCategory },
      { label: 'RULESET', value: `${text(category.ruleset?.name)} ${text(category.ruleset?.ruleVersion || category.ruleset?.version, '')}` },
      { label: 'STATUS', value: category.status }
    ], 3, portraitPage);

    sectionTitle(doc, fonts, 'PLACEMENTS', portraitPage);
    drawPlacements(doc, fonts, placements, portraitPage);
    doc.font(fonts.regular).fontSize(7).fillColor(COLORS.muted)
      .text(`Result source: ${category.placementSource === 'OPERATOR_OVERRIDE' ? 'OPERATOR OVERRIDE' : 'SOFTWARE CALCULATION'}`);

    sectionTitle(doc, fonts, `PARTICIPANTS (${participants.length})`, portraitPage);
    drawTable(doc, fonts, {
      headers: ['PLACE', 'PLAYER', 'CLUB', 'STATE', 'DISTRICT', 'BOUTS'],
      rows: participants.map(item => [item.placement, item.playerName, item.club, item.stateCode, item.district, item.boutCount]),
      widths: [58, 128, 105, 48, 128, 56],
      pageOptions: portraitPage,
      fontSize: 7
    });

    if (reportOptions.includeBoutSummary) {
      const summaryPage = { layout: 'landscape', heading: 'BOUT SUMMARY', subheading: identity };
      addPage(doc, fonts, summaryPage);
      drawTable(doc, fonts, {
        headers: ['BOUT', 'MATCH', 'STAGE', 'RED / CLUB', 'BLUE / CLUB', 'ROUND SCORES', 'WINS', 'WINNER', 'DEFEATED', 'RESULT', 'START / END'],
        rows: sortedRecords.map(record => [
          record.manualBout?.officialBoutNo,
          record.matchNo,
          record.manualBout?.stage,
          `${text(record.redName)}\n${text(record.red?.club)}`,
          `${text(record.blueName)}\n${text(record.blue?.club)}`,
          roundScores(record),
          roundWins(record),
          record.winnerName || 'DRAW',
          record.defeatedName,
          `${resultCode(record.reason)}\n${text(record.reason)}`,
          `${dateTime(record.startedAt)}\n${dateTime(record.endedAt)}`
        ]),
        widths: [40, 38, 63, 78, 78, 82, 40, 67, 67, 76, 141],
        pageOptions: summaryPage,
        fontSize: 5.8
      });
    }

    if (reportOptions.includeFullAudit) {
      for (const record of sortedRecords) {
        const bout = text(record.manualBout?.officialBoutNo || record.matchNo);
        const auditPage = {
          layout: 'landscape',
          heading: `FULL MATCH AUDIT - BOUT ${bout}`,
          subheading: `Internal match ${text(record.matchNo)} - ${text(record.redName)} vs ${text(record.blueName)} - ${text(record.reason)}`
        };
        addPage(doc, fonts, auditPage);
        sectionTitle(doc, fonts, 'ROUND AND PENALTY DETAILS', auditPage);
        drawTable(doc, fonts, {
          headers: ['ROUND', 'RED SCORE', 'BLUE SCORE', 'RED GAM-JEOM', 'BLUE GAM-JEOM', 'WINNER', 'REASON'],
          rows: (record.rounds || []).map(round => [
            round.round,
            round.red?.score ?? 0,
            round.blue?.score ?? 0,
            round.red?.gamjeom ?? 0,
            round.blue?.gamjeom ?? 0,
            round.winner || 'DRAW',
            round.reason
          ]),
          widths: [55, 75, 75, 90, 90, 85, 300],
          pageOptions: auditPage,
          fontSize: 7
        });

        sectionTitle(doc, fonts, 'OPERATOR CORRECTIONS', auditPage);
        drawTable(doc, fonts, {
          headers: ['ROUND', 'PLAYER', 'ACTION', 'FROM', 'TO', 'MATCH CLOCK', 'RECORDED AT'],
          rows: (record.operatorHistory || []).map(entry => [
            entry.round,
            entry.player,
            entry.action,
            entry.from,
            entry.to,
            clockTime(entry.timerMs),
            dateTime(entry.recordedAt)
          ]),
          widths: [55, 70, 230, 65, 65, 90, 190],
          pageOptions: auditPage,
          fontSize: 7
        });

        if (reportOptions.includeCornerRefereeHistory) {
          sectionTitle(doc, fonts, 'CORNER REFEREE HISTORY', auditPage);
          drawTable(doc, fonts, {
            headers: ['ROUND', 'REFEREE', 'BUTTON', 'SCORE', 'MATCH CLOCK', 'PRESSED AT'],
            rows: (record.cornerRefereeHistory || []).map(entry => [
              entry.round,
              entry.cornerReferee || `C${entry.corner}`,
              entry.button,
              entry.score,
              clockTime(entry.timerMs),
              dateTime(entry.pressedAt)
            ]),
            widths: [60, 90, 190, 70, 100, 255],
            pageOptions: auditPage,
            fontSize: 7
          });
        }
      }
    }

    const signaturePage = {
      layout: doc.page.layout || 'portrait',
      heading: title,
      subheading: identity
    };
    drawSignatures(doc, fonts, signaturePage);
    addPageFooters(doc, fonts, generatedAt);
    doc.end();
  });
}
