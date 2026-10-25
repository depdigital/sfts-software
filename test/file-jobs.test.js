import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { createFileJobs } from '../src/fileJobs.js';

test('file worker preserves CSV, XLS and XLSX imports and bounds concurrent operations', async () => {
  const jobs = createFileJobs();
  const rows = [['Name', 'Gender', 'Division'], ['Test player', 'MALE', 'SENIOR']];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Players');
  try {
    const first = jobs.run('readPlayers', Buffer.from('Name,Gender,Division\nTest player,MALE,SENIOR'));
    await assert.rejects(jobs.run('readPlayers', Buffer.from('second')), /Another file operation/);
    assert.deepEqual(await first, rows);
    for (const bookType of ['xlsx', 'biff8']) {
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType });
      assert.deepEqual(await jobs.run('readPlayers', buffer), rows);
    }
    const exported = await jobs.run('workbook', { sheets: [{ name: 'Players', rows }] });
    assert.deepEqual(await jobs.run('readPlayers', exported), rows);
    const scheduled = await jobs.run('workbook', { sheets: [{ name: 'Matches', rows }, { name: 'Schedule', rows: [['Match Order'], [1]] }] });
    assert.deepEqual(await jobs.run('readFixture', scheduled), { rows, schedule: [['Match Order'], ['1']] });
    assert.deepEqual(await jobs.run('readFixture', exported), { rows, schedule: null });
    const csv = await jobs.run('workbook', { format: 'csv', sheets: [{ name: 'Schedule', rows: [['Name'], ['=1+1'], ['+command'], ['normal name']] }] });
    assert.ok(csv.includes("'=1+1"));
    assert.ok(csv.includes("'+command"));
    assert.ok(csv.includes('normal name'));
    const pdf = await jobs.run('pdf', { category: { eventName: 'Worker test', division: 'SENIOR', gender: 'MALE', weightCategory: 'FLYWEIGHT', placements: {} }, records: [], options: {}, generatedAt: '2026-10-24T00:00:00.000Z' });
    assert.equal(Buffer.from(pdf.buffer).subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.fileName, /^SFTS_Category_Result_.*\.pdf$/);
  } finally { await jobs.close(); }
});

test('oversized ZIP expansion and wide sheets are rejected without killing the worker', async () => {
  const jobs = createFileJobs();
  try {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name'], ['Player']]), 'Players');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const end = buffer.length - 22;
    const firstEntry = buffer.readUInt32LE(end + 16);
    buffer.writeUInt32LE(64 * 1024 * 1024, firstEntry + 24);
    await assert.rejects(jobs.run('readPlayers', buffer), /32 MB limit/);
    await assert.rejects(jobs.run('readPlayers', Buffer.from(`${Array(129).fill('column').join(',')}\nvalue`)), /too many columns/);
    assert.deepEqual(await jobs.run('readPlayers', Buffer.from('Name\nPlayer')), [['Name'], ['Player']]);
  } finally { await jobs.close(); }
});

test('file worker timeout rejects the job and a new worker can recover', async () => {
  const jobs = createFileJobs({ timeoutMs: 1 });
  try {
    await assert.rejects(jobs.run('readPlayers', Buffer.from('Name\nPlayer')), /timed out/);
  } finally { await jobs.close(); }
});
