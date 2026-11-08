import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/js/weightLabels.js';
const {label,resolve,display}=globalThis.SftsWeightLabels;
test('numeric labels preserve legacy IDs and distinguish division and gender',()=>{
 const female={name:'LIGHTWEIGHT',limit:'OVER 49.1 TO 52.0 KG'};
 const male={name:'LIGHTWEIGHT',limit:'OVER 55.1 TO 59.0 KG'};
 const division={id:'JUNIOR',label:'JUNIOR',weightCategories:{MALE:[male],FEMALE:[female]}};
 assert.equal(label(female),'Under 52 kg');
 assert.equal(resolve(division,'FEMALE','Under 52 kgs'),female);
 assert.equal(resolve(division,'FEMALE','LIGHTWEIGHT'),female);
 assert.equal(resolve(division,'MALE','Under 52 kg'),null);
 assert.equal(display([division],{division:'JUNIOR',gender:'FEMALE',weightCategory:'LIGHTWEIGHT'}),'Under 52 kg');
 assert.equal(label({name:'HEAVYWEIGHT',limit:'OVER 68.1 KG'}),'Over 68 kg');
 assert.equal(label({name:'CUSTOM',limit:'special rules'}),'CUSTOM');
 assert.equal(display([division],{categoryGroup:'GROUP A'}),'GROUP A');
 assert.equal(female.name,'LIGHTWEIGHT');
});

import {readRulesFile} from '../src/rules.js';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('all 84 default categories resolve from numeric labels without changing limits or IDs',async()=>{
 const rules=await readRulesFile('config/rules.default.json');
 let count=0;
 for(const d of rules.tournament.divisions) for(const gender of ['MALE','FEMALE']) for(const c of d.weightCategories[gender]) {
  assert.match(label(c),/^(Under|Over) [0-9.]+ kg$/);
  assert.equal(resolve(d,gender,label(c)),c);
  assert.equal(resolve(d,gender,c.name),c);
  count++;
 }
 assert.equal(count,84);
 const source=await readFile('public/js/app.js','utf8');
 const context=vm.createContext({SftsWeightLabels:globalThis.SftsWeightLabels,rulepackDivisions:()=>rules.tournament.divisions,lastManualCompetition:{activeCategoryId:'saved',categories:[{id:'saved',division:'JUNIOR',gender:'FEMALE',weightCategory:'LIGHTWEIGHT'}]}});
 vm.runInContext(source.slice(source.indexOf('function weightCategoryDisplay(')),context);
 assert.equal(context.weightCategoryDisplay({division:'JUNIOR',weightCategory:'LIGHTWEIGHT'}),'Under 52 kg');
 assert.equal(context.weightCategoryDisplay({division:'JUNIOR',gender:'MALE',weightCategory:'LIGHTWEIGHT'}),'Under 59 kg');
});

test('explicit rulepack labels are authoritative, round-trip, and retain old input aliases',async()=>{
 const {validateRules}=await import('../src/rules.js');
 const original=await readRulesFile('config/rules.default.json');
 const draft=structuredClone(original);
 const junior=draft.tournament.divisions.find(d=>d.id==='JUNIOR');
 const category=junior.weightCategories.FEMALE.find(c=>c.name==='LIGHTWEIGHT');
 category.displayName='Up to 52 kg';
 const validated=validateRules(JSON.parse(JSON.stringify(draft)));
 const division=validated.tournament.divisions.find(d=>d.id==='JUNIOR');
 const updated=division.weightCategories.FEMALE.find(c=>c.name==='LIGHTWEIGHT');
 assert.equal(label(updated),'Up to 52 kg');
 assert.equal(display(validated.tournament.divisions,{division:'JUNIOR',gender:'FEMALE',weightCategory:'LIGHTWEIGHT'}),'Up to 52 kg');
 for(const alias of ['LIGHTWEIGHT','Under 52 kg','Up to 52 kg'])assert.equal(resolve(division,'FEMALE',alias),updated);
 assert.equal(updated.limit,category.limit);
 const legacy=structuredClone(original);
 for(const d of legacy.tournament.divisions)for(const sex of ['MALE','FEMALE'])for(const c of d.weightCategories[sex])delete c.displayName;
 assert.deepEqual(validateRules(legacy).tournament.divisions,original.tournament.divisions);
 category.displayName='FINWEIGHT';assert.throws(()=>validateRules(draft),/conflicts/);
 category.displayName='Under 49 kg';assert.throws(()=>validateRules(draft),/conflicts/);
 category.displayName='';assert.throws(()=>validateRules(draft),/displayName/);
 category.displayName=42;assert.throws(()=>validateRules(draft),/displayName/);
});
