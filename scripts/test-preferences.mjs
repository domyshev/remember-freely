import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults, loadPreferences, contentWordings, libraryRoots, topicLabel, validFaviconImage, emojiFavicon} from '../src/preferenceModel.ts';
import {russian} from '../src/translations.ts';
import {spanish} from '../src/spanish.ts';
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
 assert.deepEqual(Object.keys(spanish).sort(),Object.keys(russian).sort());
 for(const [key,value] of Object.entries({...russian,...spanish})) assert.deepEqual([...key.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...value.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),key);
});

test('topic language is independent, follows interface only on request and falls back to original',()=>{
 const node={label:'Original',translations:{en:'Numbers',es:'Números',ru:'Числа'}};
 assert.equal(topicLabel(node,'es','ru'),'Números');
 assert.equal(topicLabel(node,'interface','ru'),'Числа');
 assert.equal(topicLabel(node,'original','es'),'Original');
 assert.equal(topicLabel(node,'fr','es'),'Original');
 assert.equal(topicLabel({label:'Unlabeled'},'es','es'),'Unlabeled');
});
test('branding migration keeps old preferences, rejects remote or executable favicon URLs and escapes emoji SVG',()=>{
 const old=loadPreferences({interfaceLanguage:'ru',contentLanguages:['es'],collapseMobileHeader:false});
 assert.equal(old.siteTitle,'Remember Freely');assert.equal(old.theme,'blue');assert.deepEqual(old.contentLanguages,['es']);
 const saved=loadPreferences({interfaceLanguage:'es',topicLanguage:'interface',siteHeading:'My library',siteTitle:'Practice',theme:'rainbow',faviconEmoji:'📘'});
 assert.equal(saved.interfaceLanguage,'es');assert.equal(saved.topicLanguage,'interface');assert.equal(saved.siteTitle,'Practice');assert.equal(saved.theme,'rainbow');
 assert.equal(validFaviconImage('https://example.com/icon.png'),false);
 assert.equal(validFaviconImage('javascript:alert(1)'),false);
 assert.equal(validFaviconImage('data:image/svg+xml;base64,PHN2Zz4='),false);
 assert.equal(validFaviconImage('data:image/png;base64,aGVsbG8='),true);
 assert.equal(loadPreferences({faviconImage:'javascript:alert(1)'}).faviconImage,'');
 assert.match(decodeURIComponent(emojiFavicon('<script>')),/&lt;script&gt;/);
});
