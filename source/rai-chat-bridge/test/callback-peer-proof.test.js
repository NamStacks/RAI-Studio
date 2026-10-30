import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { nativePeerFetch } from '../rai-native-mcp.js';
const token = 'callback-fixture-secret';
const url = 'http://127.0.0.1:19091/settings';
const mac = (label, nc, nb, body = '', port = '19091', method = 'POST', uri = '/settings') =>
  createHmac('sha256', token).update(['rai-peer-v1',label,nc,nb,method,uri,port,
    createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
function fixture(mode = 'good') {
  const calls = [];
  let nc, nb = 'ab'.repeat(32);
  return { calls, fetch: async (target, options) => {
    calls.push({target,options});
    assert.equal(JSON.stringify(options).includes(token),false);
    assert.equal(options.redirect,'error');
    if (target.endsWith('/peer_challenge')) {
      const input=JSON.parse(options.body);nc=input.nc;
      assert.deepEqual(Object.keys(input).sort(),['method','nc','uri','v']);
      assert.match(nc,/^[0-9a-f]{64}$/);
      if (mode==='old') return new Response('',{status:404});
      if (mode==='oversize') return new Response('x'.repeat(65537));
      let proof=mac('native-cb-proof',nc,nb);
      if (mode==='garbage') proof='00'.repeat(32);
      if (mode==='reflection') proof=mac('mcp-cb-proof',nc,nb);
      if (mode==='relay') proof=mac('native-cb-proof',nc,nb,'','19092');
      if (mode==='replay') proof=mac('native-cb-proof','cd'.repeat(32),nb);
      if (mode==='unicode') proof='é'.repeat(64);
      return new Response(JSON.stringify({nb,proof}));
    }
    assert.equal(options.headers['X-RAI-Peer-Nonce'],nb);
    assert.equal(options.headers['X-RAI-Peer-Proof'],mac('mcp-cb-proof',nc,nb,options.body.toString()));
    return new Response('{}',{headers:mode==='no-ack'?{}:{'X-RAI-Peer-Ack':mac('native-cb-ack',nc,nb,options.body.toString())}});
  }};
}
for (const attack of ['old','garbage','reflection','relay','replay','unicode','oversize']) {
  test(`callback rejects ${attack} peer before sending tool body`,async()=> {
    const f=fixture(attack);
    await assert.rejects(nativePeerFetch(url,{method:'POST',body:new URLSearchParams({operation:'private-value'})},{token,fetch:f.fetch}));
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].options.body.includes('private-value'),false);
  });
}
test('callback sends exact form bytes with proof and requires native acknowledgement',async()=> {
  const f=fixture();
  const response=await nativePeerFetch(url,{method:'POST',body:new URLSearchParams({operation:'read',text:'é + 🌱'})},{token,fetch:f.fetch});
  assert.equal(response.status,200);assert.equal(f.calls.length,2);
});
test('callback rejects a response without acknowledgement',async()=> {
  const f=fixture('no-ack');
  await assert.rejects(nativePeerFetch(url,{method:'POST',body:new URLSearchParams()},{token,fetch:f.fetch}),/acknowledgement/);
  assert.equal(f.calls.length,2);
});
test('callback refuses a supplied bearer before any network call',async()=> {
  const f=fixture();
  await assert.rejects(nativePeerFetch(url,{method:'POST',headers:{'X-RAI-Bridge-Token':token}},{token,fetch:f.fetch}));
  assert.equal(f.calls.length,0);
});

test('S10c callback cap is 4 MiB encoded for edit only; other routes keep 256 KiB',async()=> {
  for (const [uri,limit] of [['/edit',4*1024*1024],['/settings',256*1024]]) {
    for (const extra of [0,1]) {
      let nc; const nb='ab'.repeat(32); const calls=[];
      const fetch=async(target,options)=> {
        calls.push({target,options});
        if (target.endsWith('/peer_challenge')) {
          const input=JSON.parse(options.body);nc=input.nc;assert.equal(input.uri,uri);
          return new Response(JSON.stringify({nb,proof:mac('native-cb-proof',nc,nb,'','19091','POST',uri)}));
        }
        assert.equal(options.body.length,limit);
        assert.equal(options.headers['X-RAI-Peer-Proof'],mac('mcp-cb-proof',nc,nb,options.body,'19091','POST',uri));
        return new Response('{}',{headers:{'X-RAI-Peer-Ack':mac('native-cb-ack',nc,nb,options.body,'19091','POST',uri)}});
      };
      const pending=nativePeerFetch('http://127.0.0.1:19091'+uri,{method:'POST',body:'x'.repeat(limit+extra)},{token,fetch});
      if (extra) {await assert.rejects(pending,/body limit/);assert.equal(calls.length,1);}
      else {assert.equal((await pending).status,200);assert.equal(calls.length,2);}
    }
  }
});
test('S10d write cap is route-local and exact encoded boundary',async()=> {
  for (const [uri,limit] of [['/write',4*1024*1024],['/file',256*1024],['/run',256*1024],['/document',256*1024]]) {
    for (const extra of [0,1]) {
      let nc; const nb='ab'.repeat(32); const calls=[];
      const fetch=async(target,options)=> {
        calls.push({target,options});
        if (target.endsWith('/peer_challenge')) {
          const input=JSON.parse(options.body);nc=input.nc;assert.equal(input.uri,uri);
          return new Response(JSON.stringify({nb,proof:mac('native-cb-proof',nc,nb,'','19091','POST',uri)}));
        }
        assert.equal(options.body.length,limit+extra);
        assert.equal(options.headers['X-RAI-Peer-Proof'],mac('mcp-cb-proof',nc,nb,options.body,'19091','POST',uri));
        return new Response('{}',{headers:{'X-RAI-Peer-Ack':mac('native-cb-ack',nc,nb,options.body,'19091','POST',uri)}});
      };
      const pending=nativePeerFetch('http://127.0.0.1:19091'+uri,{method:'POST',body:'x'.repeat(limit+extra)},{token,fetch});
      if (extra) {await assert.rejects(pending,/body limit/,"S10d route-local cap rejects oversized callback");assert.equal(calls.length,1);}
      else {assert.equal((await pending).status,200);assert.equal(calls.length,2);}
    }
  }
});
