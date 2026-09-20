#!/usr/bin/env node
/** Real browser QUIC upload and HTTP download regression against a disposable loopback server.
 * Start client/e2e/real-server-harness.mjs with isolated ports, then set
 * PARACORD_E2E_URL=http://127.0.0.1:<port> and run this script.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium, request }=await import(path.join(root,'client/node_modules/playwright/index.mjs'));
const { transform }=await import(path.join(root,'client/node_modules/esbuild/lib/main.js'));
const base=process.env.PARACORD_E2E_URL || 'http://127.0.0.1:18274';
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname),'Use a disposable loopback server');
const api=await request.newContext({baseURL:base});
const suffix=randomBytes(5).toString('hex');
let browser;
try {
 const register=await api.post('/api/v1/auth/register',{data:{username:`quic_${suffix}`,email:`quic_${suffix}@example.test`,password:`Release-${suffix}-Test!123`}});
 assert.equal(register.status(),201);const account=await register.json();
 const csrf=(await api.storageState()).cookies.find(cookie=>cookie.name==='paracord_csrf')?.value;
 const headers={Authorization:`Bearer ${account.token}`,'X-Paracord-CSRF':csrf};
 async function post(url,data,expected=201){const response=await api.post(url,{headers,data});assert.equal(response.status(),expected,`${url}: ${await response.text()}`);return response.json();}
 const guild=await post('/api/v1/guilds',{name:`QUIC QA ${suffix}`});
 const channel=await post(`/api/v1/guilds/${guild.id}/channels`,{name:'uploads',channel_type:0});
 async function token(size){return post(`/api/v2/channels/${channel.id}/upload-token`,{filename:'release.bin',size,content_type:'application/octet-stream'},200);}
 browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(base);
 for(const [file,name] of [['fileTransportManager','ReleaseFileTransport'],['fileTransfer','ReleaseFileUpload']]){
  const source=readFileSync(path.join(root,`client/src/lib/media/transport/${file}.ts`),'utf8');
  const compiled=await transform(source,{loader:'ts',format:'iife',globalName:name});
  await page.evaluate(`${compiled.code}\nglobalThis.${name} = ${name};`);
 }
 async function upload(authToken,streamToken,size){
  return page.evaluate(async({authToken,streamToken,size})=>{
   const manager=ReleaseFileTransport.FileTransportManager.getInstance();let transport;
   try {
    transport=await manager.getOrConnect(authToken.quic_endpoint,authToken.upload_token,authToken.cert_hash);
    const bytes=new Uint8Array(size);for(let i=0;i<size;i++)bytes[i]=(i*131+17)%256;
    const result=await new ReleaseFileUpload.QUICFileUploader().upload(transport,streamToken,new File([bytes],'release.bin',{type:'application/octet-stream'}));
    return {ok:true,result};
   }catch(error){return {ok:false,error:error.message};}
   finally {if(transport)manager.release(transport);}
  },{authToken,streamToken,size});
 }
 async function verifyRoundtrip(size){
  const capability=await token(size);assert.equal(capability.quic_available,true);assert.equal(new URL(capability.quic_endpoint).pathname,'/files');
  const result=await upload(capability,capability,size);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result.id,capability.transfer_id);
  await post(`/api/v1/channels/${channel.id}/messages`,{content:'QUIC byte round trip',attachment_ids:[result.result.id]});
  const download=await api.get(`/api/v1/attachments/${result.result.id}`,{headers});assert.equal(download.status(),200);
  const bytes=await download.body();assert.equal(bytes.length,size);for(let i=0;i<size;i++)assert.equal(bytes[i],(i*131+17)%256);
  assert.equal((await upload(capability,capability,size)).ok,false,'committed capability replay accepted');
  console.log(`PASS QUIC upload → message → HTTP download: ${size} exact bytes; replay rejected`);
 }
 await verifyRoundtrip(7);await verifyRoundtrip(1200*1024);
 const authorized=await token(7), substitute=await token(7);
 assert.equal((await upload(authorized,substitute,7)).ok,false,'different stream capability accepted');
 assert.equal((await upload(authorized,{...authorized,transfer_id:'999'},7)).ok,false,'different transfer ID accepted');
 assert.equal((await upload(await token(4),await token(4),7)).ok,false,'substitution accepted');
 const oversized=await token(4);assert.equal((await upload(oversized,oversized,7)).ok,false,'oversized data accepted');
 const truncated=await token(7);assert.equal((await upload(truncated,truncated,4)).ok,false,'premature end accepted');
 assert.equal((await upload({...authorized,upload_token:account.token},authorized,7)).ok,false,'access token accepted as file capability');
 assert.equal((await upload({...authorized,quic_endpoint:authorized.quic_endpoint.replace('/files','/media')},authorized,7)).ok,false,'file capability accepted for media');
 // Membership is checked again when a minted capability reaches QUIC.
 const guestApi=await request.newContext({baseURL:base});
 try {
  const response=await guestApi.post('/api/v1/auth/register',{data:{username:`guest_${suffix}`,email:`guest_${suffix}@example.test`,password:`Guest-${suffix}-Test!123`}});
  assert.equal(response.status(),201);const guest=await response.json();
  const guestCsrf=(await guestApi.storageState()).cookies.find(cookie=>cookie.name==='paracord_csrf')?.value;
  const guestHeaders={Authorization:`Bearer ${guest.token}`,'X-Paracord-CSRF':guestCsrf};
  const invite=await post(`/api/v1/channels/${channel.id}/invites`,{});
  assert.equal((await guestApi.post(`/api/v1/invites/${invite.code}`,{headers:guestHeaders,data:{}})).status(),200);
  const minted=await guestApi.post(`/api/v2/channels/${channel.id}/upload-token`,{headers:guestHeaders,data:{filename:'release.bin',size:7,content_type:'application/octet-stream'}});
  assert.equal(minted.status(),200);const guestCapability=await minted.json();
  assert.equal((await api.delete(`/api/v1/guilds/${guild.id}/members/${guest.user.id}`,{headers})).status(),204);
  assert.equal((await upload(guestCapability,guestCapability,7)).ok,false,'removed channel member accepted');
  assert.equal((await guestApi.post(`/api/v2/channels/${channel.id}/upload-token`,{headers:guestHeaders,data:{filename:'release.bin',size:7}})).status(),403);
  console.log('PASS membership revocation invalidates issued upload capability and prevents minting');
 } finally {await guestApi.dispose();}
 // A capability minted before sign-out must stop working immediately.
 const revoked=await token(7);
 const logout=await api.post('/api/v1/auth/logout',{headers});assert.ok([200,204].includes(logout.status()));
 assert.equal((await upload(revoked,revoked,7)).ok,false,'revoked auth session accepted');
 console.log('PASS capability/transfer substitution, oversized bytes, premature end, wrong token purpose/path, revoked session rejected');
}finally {await browser?.close();await api.dispose();}
