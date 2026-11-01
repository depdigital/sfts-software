import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('download action surfaces the useful server error instead of a generic HTTP status',async()=>{
  const app=await readFile(new URL('../public/js/app.js',import.meta.url),'utf8'),messages=[],requests=[];
  const context=vm.createContext({hostToken:'host',toast:message=>messages.push(message),fetch:async(url,options)=>{requests.push({url,options});return {ok:false,status:400,json:async()=>({message:'Import a fresh Tournament Desk Master Excel file.'})};}});
  vm.runInContext(app.slice(app.indexOf('async function downloadFile('),app.indexOf('function downloadPlayerTemplate(')),context);
  vm.runInContext(app.slice(app.indexOf('function downloadTournamentDeskResults('),app.indexOf('function downloadTournamentSchedule(')),context);
  await context.downloadFile('/api/tournament/desk-results.json','results.json');
  assert.equal(requests[0].options.headers['X-SFTS-Host-Token'],'host');
  assert.equal(messages[0],'Import a fresh Tournament Desk Master Excel file.');
});
