import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;

// Check ZIP directory sizes before SheetJS inflates an XLSX/ODS container.
// Plain CSV and legacy OLE XLS are still supported under the worker limits.
function checkContainer(buffer) {
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES) throw new Error('Player sheet is empty or too large');
  if (buffer.readUInt16LE(0) !== 0x4b50) return;
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error('Invalid spreadsheet ZIP directory');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const directoryStart = offset;
  const directoryEnd = offset + buffer.readUInt32LE(end + 12);
  if (count > 2048 || directoryEnd > end || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) {
    throw new Error('Spreadsheet container exceeds supported limits');
  }
  let expanded = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid spreadsheet ZIP entry');
    const size = buffer.readUInt32LE(offset + 24);
    const compressed = buffer.readUInt32LE(offset + 20);
    const local = buffer.readUInt32LE(offset + 42);
    const method = buffer.readUInt16LE(offset + 10);
    const flags = buffer.readUInt16LE(offset + 8);
    expanded += size;
    if ((flags & 1) || size > 16 * 1024 * 1024 || expanded > MAX_EXPANDED_BYTES) {
      throw new Error('Spreadsheet is encrypted or expands beyond the 32 MB limit');
    }
    if (local + 30 > directoryStart || buffer.readUInt32LE(local) !== 0x04034b50 || ![0, 8].includes(method) || buffer.readUInt16LE(local + 8) !== method) {
      throw new Error('Unsupported spreadsheet ZIP entry');
    }
    const localSize = buffer.readUInt32LE(local + 22);
    const localCompressed = buffer.readUInt32LE(local + 18);
    if ((localSize !== 0 && localSize !== size) || (localCompressed !== 0 && localCompressed !== compressed)) {
      throw new Error('Inconsistent spreadsheet ZIP sizes');
    }
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (dataStart + compressed > directoryStart) throw new Error('Invalid spreadsheet ZIP data range');
    const input = buffer.subarray(dataStart, dataStart + compressed);
    const output = method === 8 ? inflateRawSync(input, { maxOutputLength: Math.max(1, size) }) : input;
    if (output.length !== size) throw new Error('Inconsistent expanded spreadsheet ZIP size');
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  if (offset !== directoryEnd) throw new Error('Invalid spreadsheet ZIP directory length');
}

async function execute(type, data) {
  if (type === 'pdf') {
    const { createManualCategoryPdf, manualCategoryPdfFileName } = await import('./manualCategoryPdf.js');
    return {
      buffer: await createManualCategoryPdf(data),
      fileName: manualCategoryPdfFileName(data.category, new Date(data.generatedAt))
    };
  }
  // CommonJS preserves SheetJS's legacy XLS code-page support.
  const XLSX = require('xlsx');
  if (type === 'readPlayers') {
    const buffer = Buffer.from(data);
    checkContainer(buffer);
    const workbook = XLSX.read(buffer, {
      type: 'buffer', cellFormula: false, cellNF: false, cellStyles: false,
      bookVBA: false, dense: true, sheets: 0, sheetRows: 502
    });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw new Error('The workbook does not contain a worksheet');
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    if (range.e.c >= 128) throw new Error('The player sheet has too many columns (maximum 128)');
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
  }
  if (type === 'workbook') {
    const workbook = XLSX.utils.book_new();
    for (const item of data.sheets) {
      const csvValue = value => typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
      const rows = data.format === 'csv' ? item.rows.map(row => Array.isArray(row)
        ? row.map(csvValue)
        : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, csvValue(value)]))) : item.rows;
      const sheet = item.json ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet(rows);
      if (item.cols) sheet['!cols'] = item.cols;
      if (item.filter) sheet['!autofilter'] = { ref: item.filter };
      XLSX.utils.book_append_sheet(workbook, sheet, item.name);
    }
    return XLSX.write(workbook, { type: data.format === 'csv' ? 'string' : 'buffer', bookType: data.format || 'xlsx' });
  }
  throw new Error('Unknown file operation');
}

parentPort.on('message', async ({ id, type, data }) => {
  try {
    const result = await execute(type, data);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || 'Could not process this file' });
  }
});
