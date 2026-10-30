import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
const wrapped = new WeakSet();
const mac = (token, label, nc, nb, url, method, body = '') => createHmac('sha256',token).update([
  'rai-peer-v1',label,nc,nb,method,new URL(url).pathname,new URL(url).port || '80',
  createHash('sha256').update(body).digest('hex')
].join('\n')).digest('hex');
export function proofConfig(config) {
  if (!config?.fetch || wrapped.has(config.fetch)) return config;
  const fetch = config.fetch;
  const pending = new Map();
  config.fetch = async (url, options) => {
    assert.equal(options.headers?.['X-RAI-Bridge-Token'], undefined);
    if (new URL(url).pathname === '/peer_challenge') {
      const { nc, method, uri } = JSON.parse(options.body);
      const nb = randomBytes(32).toString('hex');
      const target = new URL(uri,url).href;
      pending.set(nb,{nc,method,target});
      return new Response(JSON.stringify({nb,proof:mac(config.token,'native-cb-proof',nc,nb,target,method)}));
    }
    const nb=options.headers['X-RAI-Peer-Nonce'];
    const p=pending.get(nb);pending.delete(nb);assert.ok(p);
    const body=options.body?.toString() ?? '';
    assert.equal(options.headers['X-RAI-Peer-Proof'],mac(config.token,'mcp-cb-proof',p.nc,nb,url,options.method,body));
    const response=await fetch(url,options);
    const headers=response.headers;
    return {...response,headers:{get:name=>name.toLowerCase()==='x-rai-peer-ack'
      ? mac(config.token,'native-cb-ack',p.nc,nb,url,options.method,body) : headers?.get(name)}};
  };
  wrapped.add(config.fetch);
  return config;
}

export function proofNativeServer(token, handler) {
  const pending = new Map();
  return async (req,res) => {
    assert.equal(req.headers['x-rai-bridge-token'],undefined);
    let raw='';for await (const chunk of req) raw+=chunk;
    const origin=`http://127.0.0.1:${req.socket.localPort}`;
    if (req.url==='/peer_challenge') {
      const {nc,method,uri}=JSON.parse(raw);
      const nb=randomBytes(32).toString('hex');
      pending.set(nb,{nc,method,uri});
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({nb,proof:mac(token,'native-cb-proof',nc,nb,origin+uri,method)}));
      return;
    }
    const nb=req.headers['x-rai-peer-nonce'];
    const entry=pending.get(nb);pending.delete(nb);assert.ok(entry);
    assert.equal(entry.method,req.method);assert.equal(entry.uri,req.url);
    assert.equal(req.headers['x-rai-peer-proof'],mac(token,'mcp-cb-proof',entry.nc,nb,origin+req.url,req.method,raw));
    res.setHeader('X-RAI-Peer-Ack',mac(token,'native-cb-ack',entry.nc,nb,origin+req.url,req.method,raw));
    await handler(req,res,raw);
  };
}
