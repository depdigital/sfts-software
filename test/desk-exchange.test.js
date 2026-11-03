import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildFixtureProgression, refreshFixtureProgression } from '../src/fixtureProgression.js';
import { readDeskMetadata, attachDeskMetadata, exportDeskResults, fixtureFingerprint, validateDeskRecords } from '../src/deskExchange.js';

function fixture() {
  const players=['Club A','Club B','Club C'].map((club,index)=>({id:`P${index+1}`,playerName:index<2?'Same Name':'Third Athlete',club}));
  const current={progressionMode:'OPENING_FIXTURE',event:{division:'SENIOR',divisionLabel:'Senior',gender:'MALE',weightCategory:'FINWEIGHT',categoryGroup:''},players,
    schedule:[{boutNo:1,officialBoutNo:'1',stage:'SEMIFINAL',RED:players[0],BLUE:players[1],redPlayerName:players[0].playerName,bluePlayerName:players[1].playerName},{boutNo:2,officialBoutNo:'2',stage:'SEMIFINAL',RED:players[2],BLUE:null,redPlayerName:players[2].playerName,bluePlayerName:'BYE'}]};
  buildFixtureProgression(current);
  const definition={divisionId:'desk-division',category:['SENIOR','MALE','FINWEIGHT',''],slots:[...players.map((player,index)=>({id:`desk-player-${index+1}`,name:player.playerName,club:player.club})),null],matches:current.schedule.map((bout,index)=>({matchId:`desk-match-${index+1}`,bout:bout.officialBoutNo,stage:bout.stage,round:bout.round,index:index<2?index:0,redSource:index===2?'desk-match-1':null,blueSource:index===2?'desk-match-2':null}))};
  definition.fingerprint=fixtureFingerprint(definition);
  const metadata={format:'sfts.fixtures',version:1,event:{id:'desk-event',name:'Exchange test',date:'2026-11-01'},fixtures:[definition]};
  const workbook={categories:[{fixture:current}]};
  attachDeskMetadata(workbook,metadata);
  return {current,definition,metadata,workbook};
}

test('chunked metadata reconstructs Unicode and rejects unknown versions and missing chunks',()=>{
  const {metadata}=fixture();metadata.event.name='Cup ⚡';
  const payload=JSON.stringify(metadata),rows=[['Format','Version','Chunk','Payload']];
  for(let offset=0;offset<payload.length;offset+=31)rows.push(['sfts.fixtures','1',String(offset/31+1),payload.slice(offset,offset+31)]);
  assert.deepEqual(readDeskMetadata(rows),metadata);
  assert.equal(readDeskMetadata(undefined),null);
  const invalid=structuredClone(rows);invalid[1][1]='2';assert.throws(()=>readDeskMetadata(invalid),/Unsupported/);
  assert.throws(()=>readDeskMetadata([rows[0],...rows.slice(2)]),/incomplete/);
});

test('result snapshots use original IDs for namesakes and skip BYEs and undecided matches',()=>{
  const {current,workbook}=fixture();
  assert.equal(exportDeskResults(workbook).results.length,0);
  current.schedule[0].status='TIE_PENDING';assert.equal(exportDeskResults(workbook).results.length,0);
  Object.assign(current.schedule[0],{status:'COMPLETED',winner:'BLUE'});refreshFixtureProgression(current);
  let result=exportDeskResults(workbook,'2');assert.equal(result.results.length,1);
  assert.deepEqual(result.results[0],{divisionId:'desk-division',matchId:'desk-match-1',hongId:'desk-player-1',chungId:'desk-player-2',winnerId:'desk-player-2'});
  Object.assign(current.schedule[2],{status:'COMPLETED',winner:'BLUE'});refreshFixtureProgression(current);
  result=exportDeskResults(workbook);assert.equal(result.results.length,2);assert.equal(result.results[1].winnerId,'desk-player-3');
});

test('changed hashes, sources, competitors, duplicate divisions and recovery failures block export',()=>{
  for(const [edit,pattern] of [
    [value=>value.definition.fingerprint='0'.repeat(64),/fingerprint/],
    [value=>value.definition.matches[2].redSource='wrong',/sources differ/],
    [value=>value.current.schedule[0].RED.club='Wrong club',/competitors or corners/],
    [value=>value.current.recoveryError='review',/recovery review/],
    [value=>value.workbook.categories.push(value.workbook.categories[0]),/Duplicate/],
  ]) {const value=fixture();edit(value);assert.throws(()=>exportDeskResults(value.workbook),pattern);}
  assert.throws(()=>exportDeskResults(null),/Import a fresh/);
  const value=fixture();delete value.current.deskExchange;assert.throws(()=>exportDeskResults(value.workbook),/identity is missing/);
});

test('archived bouts remain bound to the originating event and approved fixture',()=>{
  const {current,definition}=fixture();current.categoryId='category';
  const record={manualBout:{categoryId:'category',deskEventId:'desk-event',deskFixtureFingerprint:definition.fingerprint}};
  validateDeskRecords(current,[record]);
  record.manualBout.deskEventId='other-event';assert.throws(()=>validateDeskRecords(current,[record]),/another or unlinked/);
  delete record.manualBout.deskEventId;assert.throws(()=>validateDeskRecords(current,[record]),/another or unlinked/);
});

test('USB export reports errors without downloading locally, prevents duplicate saves and reports the saved filename',async()=>{
  const app=await readFile(new URL('../public/js/app.js',import.meta.url),'utf8'),messages=[],requests=[];
  const buttons = [{ disabled: false }, { disabled: false }];
  const context=vm.createContext({hostToken:'host',usbImportOnly:true,tournamentDeskExportBusy:false,$:id=>buttons[id === 'importDeskResultsExportButton' ? 0 : 1],toast:message=>messages.push(message),fetch:async(url,options)=>{requests.push({url,options});return {ok:false,status:400,json:async()=>({message:'USB DRIVE NOT DETECTED'})};}});
  vm.runInContext(app.slice(app.indexOf('async function saveTournamentDeskResultsToUsb('),app.indexOf('function downloadTournamentSchedule(')),context);
  await context.saveTournamentDeskResultsToUsb();
  assert.equal(requests[0].url,'/api/tournament/desk-results-usb');
  assert.equal(requests[0].options.method,'POST');
  assert.equal(requests[0].options.headers['X-SFTS-Host-Token'],'host');
  assert.equal(messages.at(-1),'USB DRIVE NOT DETECTED');
  assert.ok(buttons.every(button=>!button.disabled));
  let finish;
  context.fetch = async (url, options) => {
    requests.push({url,options});
    return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({ok:true,fileName:'sfts-tournamentdesk-results_1.json'})});});
  };
  const saving = context.saveTournamentDeskResultsToUsb();
  assert.ok(buttons.every(button=>button.disabled));
  await context.saveTournamentDeskResultsToUsb();
  assert.equal(requests.length,2);
  finish();
  await saving;
  assert.match(messages.at(-1),/SAVED TO USB: sfts-tournamentdesk-results_1.json/);
  context.usbImportOnly=false;
  await context.saveTournamentDeskResultsToUsb();
  assert.equal(requests.length,2,'disabled USB mode cannot fall back to a download');
  context.hostToken='';
  await context.saveTournamentDeskResultsToUsb();
  assert.equal(messages.at(-1),'HOST SESSION REQUIRED');
});

test('USB result route writes valid cumulative JSON, preserves earlier exports and rejects changed sessions or missing drives',async t=>{
  const source=await readFile(new URL('../src/server.js',import.meta.url),'utf8');
  const mountPath=await mkdtemp(path.join(os.tmpdir(),'sfts-usb-export-'));
  t.after(()=>rm(mountPath,{recursive:true,force:true}));
  const {current,workbook}=fixture();
  Object.assign(current.schedule[0],{status:'COMPLETED',winner:'BLUE'});
  refreshFixtureProgression(current);
  const routes=new Map();
  let authorized=true,usb={mounted:true,mountPath};
  const context=vm.createContext({
    path,crypto,lstat,open,rename,rm,stat,Buffer,process,
    app:{get:(url,...handlers)=>routes.set(`GET ${url}`,handlers.at(-1)),post:(url,...handlers)=>routes.set(`POST ${url}`,handlers.at(-1))},
    requireHostRequest(){},USB_IMPORT_ONLY:true,importedWorkbook:workbook,arenaNumber:'2',
    exportDeskResults,withUsbOperation:action=>action(),hostRequestAuthorized:()=>authorized,
    usbContext:async options=>{assert.equal(options.mountIfNeeded,true);return usb;}
  });
  vm.runInContext(source.slice(source.indexOf('async function availableUsbTarget('),source.indexOf('async function unmountUsb(')),context);
  vm.runInContext(source.slice(source.indexOf("app.get('/api/tournament/desk-results.json'"),source.indexOf("app.get('/api/tournament/schedule.csv'")),context);
  const request=async(method='POST')=>{
    const response={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
    await routes.get(`${method} /api/tournament/${method==='GET'?'desk-results.json':'desk-results-usb'}`)({},response);
    return response;
  };
  const first=await request();
  assert.equal(first.statusCode,200);
  assert.equal(first.body.fileName,'sfts-tournamentdesk-results.json');
  assert.equal(first.body.results,undefined,'HTTP success returns file metadata rather than result data');
  const file=await readFile(path.join(mountPath,first.body.fileName));
  assert.equal(first.body.size,file.length);
  const result=JSON.parse(file.toString('utf8'));
  assert.equal(result.format,'sfts.results');
  assert.equal(result.arenaNumber,'2');
  assert.equal(result.results[0].winnerId,'desk-player-2');
  const second=await request();
  assert.equal(second.body.fileName,'sfts-tournamentdesk-results_1.json');
  assert.deepEqual(await readFile(path.join(mountPath,first.body.fileName)),file);
  const before=await readdir(mountPath);
  usb={mounted:false,message:'USB DRIVE NOT DETECTED'};
  assert.equal((await request()).body.message,'USB DRIVE NOT DETECTED');
  usb={mounted:true,mountPath};authorized=false;
  assert.match((await request()).body.message,/Host session.*changed/);
  authorized=true;context.importedWorkbook=null;
  assert.match((await request()).body.message,/Import a fresh/);
  assert.deepEqual(await readdir(mountPath),before);
  const blocked=await request('GET');
  assert.equal(blocked.statusCode,403);
  assert.equal(blocked.body.results,undefined);
  context.USB_IMPORT_ONLY=false;
  assert.equal((await request()).statusCode,403);
});

test('failed USB writes remove temporary files and leave previous result files intact',async t=>{
  const source=await readFile(new URL('../src/server.js',import.meta.url),'utf8');
  const mountPath=await mkdtemp(path.join(os.tmpdir(),'sfts-usb-failure-'));
  t.after(()=>rm(mountPath,{recursive:true,force:true}));
  const context=vm.createContext({path,crypto,lstat,open,rename,rm,stat,process});
  vm.runInContext(source.slice(source.indexOf('async function availableUsbTarget('),source.indexOf('async function writeManualCategoryPdfToUsb(')),context);
  await context.writeFileToUsb({mounted:true,mountPath},'results.json','original');
  context.open=async(...args)=>{
    const handle=await open(...args);
    return {writeFile:value=>handle.writeFile(value),close:()=>handle.close(),sync:async()=>{throw new Error('USB write failed');}};
  };
  await assert.rejects(context.writeFileToUsb({mounted:true,mountPath},'results.json','replacement'),/USB write failed/);
  assert.deepEqual(await readdir(mountPath),['results.json']);
  assert.equal(await readFile(path.join(mountPath,'results.json'),'utf8'),'original');
});
