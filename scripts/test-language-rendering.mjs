import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const cache=new Map();
function load(file) {
 if(cache.has(file)) return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const localRequire=name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)+(name.endsWith('Preferences')?'.tsx':'.ts')):require(name);
 vm.runInThisContext(`(function(require,module,exports){${code}\n})`,{filename:file})(localRequire,module,module.exports);
 return module.exports;
}
const {PreferencesProvider,QuestionText,useT}=load(path.resolve('src/Preferences.tsx'));
function Greeting(){const t=useT();return React.createElement('p',null,t('Settings'));}
test('server rendering uses English by default and Russian only when selected',()=>{
 globalThis.localStorage={getItem:()=>null};
 assert.match(renderToStaticMarkup(React.createElement(PreferencesProvider,null,React.createElement(Greeting))),/>Settings</);
 globalThis.localStorage={getItem:()=>JSON.stringify({interfaceLanguage:'ru'})};
 assert.match(renderToStaticMarkup(React.createElement(PreferencesProvider,null,React.createElement(Greeting))),/>Настройки</);
 globalThis.localStorage={getItem:()=>JSON.stringify({interfaceLanguage:'es'})};
 assert.match(renderToStaticMarkup(React.createElement(PreferencesProvider,null,React.createElement(Greeting))),/>Configuración</);
 delete globalThis.localStorage;
});
test('rendered question and answer texts share selected languages and escape markup',()=>{
 globalThis.localStorage={getItem:()=>JSON.stringify({interfaceLanguage:'en',contentLanguages:['ru']})};
 const output=renderToStaticMarkup(React.createElement(PreferencesProvider,null,React.createElement(QuestionText,{text:'Original',translations:{en:'English',ru:'<b>Русский</b>'}})));
 assert.match(output,/lang="ru"/);assert.match(output,/&lt;b&gt;Русский&lt;\/b&gt;/);assert.doesNotMatch(output,/English/);
 delete globalThis.localStorage;
});

test('the menu appearance panel renders Spanish labels and saved branding safely',()=>{
 const {AppearancePreferences}=load(path.resolve('src/Appearance.tsx'));
 globalThis.localStorage={getItem:()=>JSON.stringify({interfaceLanguage:'es',siteHeading:'My <library>',siteTitle:'Practice',theme:'rainbow',faviconEmoji:'📘'})};
 const output=renderToStaticMarkup(React.createElement(PreferencesProvider,null,React.createElement(AppearancePreferences)));
 assert.match(output,/Apariencia/);assert.match(output,/Encabezado del sitio/);assert.match(output,/Título de la pestaña/);assert.match(output,/Arcoíris/);
 assert.match(output,/value="My &lt;library&gt;"/);assert.match(output,/value="rainbow" selected=""/);
 delete globalThis.localStorage;
});
