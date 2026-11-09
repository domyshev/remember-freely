import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults, loadPreferences, contentWordings, libraryRoots} from '../src/preferenceModel.ts';
import {russian} from '../src/translations.ts';
test('English default, old browser preferences, and corrupt saved values', () => {
 assert.equal(defaults.interfaceLanguage,'en');
 assert.equal(loadPreferences({collapseMobileHeader:false}).collapseMobileHeader,false);
 assert.deepEqual(loadPreferences(null),defaults);
 assert.deepEqual(loadPreferences({interfaceLanguage:'xx',contentLanguages:[null],hideSingleRoot:'false'}),defaults);
 assert.deepEqual(loadPreferences({contentLanguages:['en','en','ru']}).contentLanguages,['en','ru']);
});
test('content languages are independent of UI language, preserve multiline text and safely fall back', () => {
 const variants={es:'Uno\nDos',en:'One\nTwo',ru:'Один\nДва'};
 assert.deepEqual(contentWordings('Original',variants,['ru','es']),[{language:'ru',text:variants.ru},{language:'es',text:variants.es}]);
 assert.equal(contentWordings('Original',variants,[]).length,3);
 assert.deepEqual(contentWordings('Original',variants,['fr']),[{text:'Original'}]);
 assert.deepEqual(contentWordings('',{fr:'Deux paires.'},['en']),[{text:'Deux paires.'}]);
 assert.deepEqual(contentWordings('Unlabeled\ncontent',undefined,['en']),[{text:'Unlabeled\ncontent'}]);
});
test('flatten only a single non-leaf root and retain all roots or requested section', () => {
 const nodes=[{id:'a',parent_id:null},{id:'child',parent_id:'a'},{id:'leaf',parent_id:'child'}];
 assert.deepEqual(libraryRoots(nodes,'',true).map(n=>n.id),['child']);
 assert.deepEqual(libraryRoots(nodes,'',false).map(n=>n.id),['a']);
 const many=[...nodes,{id:'b',parent_id:null}];
 assert.deepEqual(libraryRoots(many,'',true).map(n=>n.id),['a','b']);
 assert.deepEqual(libraryRoots(many,'a',true).map(n=>n.id),['child']);
 assert.deepEqual(libraryRoots(many,'missing',true).map(n=>n.id),['a','b']);
 assert.deepEqual(libraryRoots([{id:'leaf',parent_id:null}],'',true).map(n=>n.id),['leaf']);
});
test('Russian placeholders match the English catalog', () => {
 for(const [key,value] of Object.entries(russian)) assert.deepEqual([...key.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),key);
});
