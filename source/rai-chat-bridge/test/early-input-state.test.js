import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(process.env.S9C_STATE_SOURCE || new URL('../server.js',import.meta.url),'utf8');
function fixture() {
  let connect, release;
  const tasks=[];const writes=[];const sizes=[];
  const store={term:null,client:null,busy:false,attach(ws){const old=this.client;this.client=ws;return old;},detach(ws){if(this.client===ws)this.client=null;},snapshotOutput:()=>null};
  const context={Buffer,store,canonicalSettingsReady:false,terminalSize:{cols:120,rows:40},
    withSettingsAuthority:f=>{tasks.push(f);return Promise.resolve();},refreshCanonicalSettings:()=>new Promise(r=>{release=r;}),
    sendToClient:()=>{},sendStatus:()=>{},runInspector:{get:()=>({}),reset:()=>{}},stopTerm:()=>context.clearPendingInput(),
    wss:{on:(event,fn)=>{connect=fn;}},server:{listen:()=>{}},PORT:0,HOST:'127.0.0.1',
    start:()=>{store.term={write:d=>writes.push(d),resize:(...s)=>sizes.push(s)};context.flushPendingInput(store.term);return true;},
    startSignIn:()=>context.start()};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const INPUT_QUEUE_BYTES'),source.indexOf('function stopTerm(')),context);
  vm.runInContext(source.slice(source.indexOf("wss.on('connection'")),context);
  function socket(){const handlers={};const ws={OPEN:1,readyState:1,send:()=>{},on:(event,fn)=>{handlers[event]=fn;},close(code,reason){this.closed={code,reason};this.readyState=3;},emit(type,data){handlers[type]?.(type==='message'?Buffer.from(JSON.stringify(data)):data);}};connect(ws);return ws;}
  return {context,store,writes,sizes,tasks,socket,release:()=>release(),async ready(){const task=tasks.shift()();await Promise.resolve();release();await task;}};
}
test('queue preserves UTF-8, bracketed paste, binary JSON and control bytes exactly once',async()=>{
  const f=fixture(),ws=f.socket(),chunks=['é\x00','\x1b[200~one\ntwo\x1b[201~','\x03'];
  for(const data of chunks)ws.emit('message',{type:'input',data});
  await f.ready();assert.deepEqual(f.writes,chunks);f.context.flushPendingInput(f.store.term);assert.deepEqual(f.writes,chunks);
});
for(const action of ['restart','stop','sign_in','close','replace'])test(`pending generation invalidated by ${action}`,async()=>{
  const f=fixture();let ws=f.socket();ws.emit('message',{type:'input',data:'STALE'});
  const old=f.tasks.shift()();await Promise.resolve();
  if(action==='replace')ws=f.socket();else ws.emit(action==='close'?'close':'message',{type:action});
  f.release();await old;assert.equal(f.store.term,null);assert.deepEqual(f.writes,[]);
  if(action==='stop'||action==='close')ws=f.socket();
  ws.emit('message',{type:'input',data:'FRESH'});
  // Discard obsolete queued settings operations before releasing the current one.
  while(f.tasks.length>1)await f.tasks.shift()();
  await f.ready();assert.deepEqual(f.writes,['FRESH']);
});
for(const mode of ['bytes','frames'])test(`queue is bounded by ${mode} and closes explicitly`,async()=>{
  const f=fixture(),ws=f.socket();
  if(mode==='bytes')ws.emit('message',{type:'input',data:'é'.repeat(524289)});
  else for(let i=0;i<1025;i++)ws.emit('message',{type:'input',data:''});
  assert.equal(ws.closed?.code,1009);assert.match(ws.closed.reason,/input queue/);
  await f.tasks.shift()();assert.equal(f.store.term,null);assert.deepEqual(f.writes,[]);
});
test('superseded client cannot input, resize or control the current session',async()=>{
  const f=fixture(),old=f.socket(),current=f.socket();
  for(const type of ['input','resize','restart','stop','sign_in'])old.emit('message',{type,data:'STALE',cols:99,rows:99});
  current.emit('message',{type:'input',data:'CURRENT'});
  await f.tasks.shift()();await f.ready();assert.deepEqual(f.writes,['CURRENT']);assert.equal(f.context.terminalSize.cols,120);
});
test('no-term reconnect still refreshes native settings even after an earlier canonical read',async()=>{
  const f=fixture();f.context.canonicalSettingsReady=true;
  const ws=f.socket();ws.emit('message',{type:'input',data:'WAIT'});
  assert.equal(f.store.term,null);assert.deepEqual(f.writes,[]);
  await f.ready();assert.deepEqual(f.writes,['WAIT']);
});
test('latest resize survives the pending read and ready resizes reach the PTY',async()=>{
  const f=fixture(),ws=f.socket();
  ws.emit('message',{type:'resize',cols:71,rows:22});ws.emit('message',{type:'resize',cols:73,rows:27});
  await f.ready();assert.equal(f.context.terminalSize.cols,73);assert.equal(f.context.terminalSize.rows,27);
  ws.emit('message',{type:'resize',cols:74,rows:28});assert.deepEqual(f.sizes,[[74,28]]);
});
