import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseStamp} from '../src/releaseMetadata.ts';
test('show a real build date without inventing a deployment date',()=>{
 const build={version:'0.2.1',built_at:'2026-11-09T10:00:00Z'};
 assert.deepEqual(releaseStamp('0.2.1',build),{label:'Built',at:build.built_at});
 assert.deepEqual(releaseStamp('0.2.1',build,{version:'0.2.1',deployed_at:'2026-11-09T10:10:00Z',changes:[]}),{label:'Deployed',at:'2026-11-09T10:10:00Z'});
 assert.deepEqual(releaseStamp('0.2.1',build,{version:'0.2.0',deployed_at:'2026-11-01T10:10:00Z',changes:[]}),{label:'Built',at:build.built_at});
 assert.equal(releaseStamp('0.2.1',{version:'0.2.0',built_at:build.built_at}),null);
 assert.equal(releaseStamp('0.2.1',{version:'0.2.1',built_at:'bad date'}),null);
});
