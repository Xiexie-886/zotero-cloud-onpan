const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
function setup() {
 const values=new Map(),calls=[],prefs=new Map([['sync.storage.protocol','zotero']]);
 const branch={getStringPref:(k,f)=>values.get(k)||f,setStringPref:(k,v)=>values.set(k,v)};
 const nativeSync=async function(o){calls.push(['sync',o]);};
 const runner={sync:nativeSync,downloadFile:async()=>{calls.push(['download']);return 5;},stop:()=>calls.push(['stop']),addError:e=>calls.push(['error',e]),getStorageController:()=>({native:true}),syncInProgress:false};
 function WebDAV(options){this.options=options;}
 WebDAV.prototype.checkServer=async()=>{};
 const local={getModeForLibrary:()=> 'zfs',getEnabledForLibrary:()=>true,downloadOnSync:()=>false,downloadAsNeeded:()=>true,resetAllSyncStates:async()=>calls.push(['reset'])};
 const Zotero={initializationPromise:Promise.resolve(),Sync:{Runner:runner,Storage:{Mode:{WebDAV},Local:local}},Users:{getCurrentUserID:()=>123},Libraries:{userLibraryID:1,getAll:()=>[{libraryID:1},{libraryID:2}]},getMainWindows:()=>[],Promise:{delay:async()=>{}},Prefs:{get:k=>prefs.get(k),set:(k,v)=>prefs.set(k,v)},OSKeyStore:{isEncrypted:s=>s.startsWith('encrypted:'),encrypt:async s=>'encrypted:'+s,decrypt:async s=>s.slice(10)}};
 const Services={prefs:{getBranch:()=>branch,savePrefFile:()=>calls.push(['flush-prefs'])},appShell:{hiddenDOMWindow:{}},io:{newURI:s=>({spec:s})}};
 const ctx=vm.createContext({Zotero,Services,ChromeUtils:{},Components:{},URL,URLSearchParams,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,console});
 for(const n of ['core.js','providers.js','runtime.js'])vm.runInContext(fs.readFileSync(path.join(root,n),'utf8'),ctx);
 const rt=new ctx.CloudRuntime({rootURI:'file://test/'},ctx.CloudCore,ctx.CloudProviders);
 const config={provider:'quark',quarkFolder:'folder123',maxMB:64,consent:true};
 values.set('config',JSON.stringify(config));
 return {ctx,rt,Zotero,Services,values,calls,nativeSync,runner,local,prefs,config};
}
test('startup opens no server and separates native metadata sync from attachment sync',async()=>{
 const {rt,runner,local,calls,nativeSync,prefs}=setup();await rt.startup();assert.equal(rt.active,null);
 await runner.sync();assert.deepEqual(Array.from(calls[0][1].fileLibraries),[2]);assert.equal(local.getEnabledForLibrary(1),false);
 await assert.rejects(runner.downloadFile({libraryID:1}),/网盘按需同步/);
 assert.equal(await runner.downloadFile({libraryID:2}),5);
 assert.equal(prefs.get('sync.storage.protocol'),'zotero');
 await rt.shutdown();assert.equal(runner.sync,nativeSync);assert.equal(local.getEnabledForLibrary(1),true);
});
test('without opt-in original sync settings and handlers continue normally',async()=>{
 const {rt,runner,calls,values,config,local}=setup();values.set('config',JSON.stringify({...config,consent:false}));await rt.startup();
 const opts={libraries:[1,2]};await runner.sync(opts);assert.equal(calls[0][1],opts);assert.equal(local.getEnabledForLibrary(1),true);await rt.shutdown();
});
test('active session supplies its own WebDAV controller without changing saved credentials',async()=>{
 const {rt,runner,local,Services}=setup();await rt.startup();
 rt.active={base:'http://127.0.0.1:12345/random/',password:'temporary',auth:'Basic test',controller:null};
 assert.equal(local.getModeForLibrary(1),'webdav');assert.equal(local.getModeForLibrary(2),'zfs');assert.equal(local.downloadOnSync(1),true);assert.equal(local.downloadAsNeeded(1),false);
 const c=runner.getStorageController('webdav',{apiClient:1});await c._init();
 assert.equal(c.verified,false);c.verified=true;assert.equal(c.verified,true);assert.equal(c._basicAuthHeader,'Basic test');
 assert.equal(await c.getPassword(),'temporary');assert.equal(c._rootURI.spec,'http://cloud:temporary@127.0.0.1:12345/random/zotero/');
 rt.active=null;await rt.shutdown();
});
test('saving settings encrypts credentials and does not access a cloud account',async()=>{
 const{rt,config,values}=setup();await rt.saveSettings(config,{quarkCookie:'__puus=private'});
 assert.ok(values.get('credentials').startsWith('encrypted:'));assert.doesNotMatch(values.get('config'),/private/);assert.equal((await rt.secrets()).quarkCookie,'__puus=private');
 await rt.saveSettings(config,{});assert.equal((await rt.secrets()).quarkCookie,'__puus=private');
 await assert.rejects(rt.saveSettings(config,{quarkCookie:'secret\r\nInjected: yes'}));
});
test('unavailable key encryption refuses to save plaintext credentials',async()=>{
 const{rt,config,values,Zotero}=setup();Zotero.OSKeyStore.encrypt=async()=>{throw Error('locked');};await assert.rejects(rt.saveSettings(config,{quarkCookie:'private'}));assert.equal(values.has('credentials'),false);
});
test('saving flushes preferences and records presence metadata without storing credential plaintext there',async()=>{
 const{rt,config,values,calls}=setup();await rt.saveSettings(config,{quarkCookie:'mock-cookie',baiduSecret:'mock-secret'});
 const state=rt.configurationState();assert.ok(state.savedAt);assert.equal(state.credentials.quarkCookie,true);assert.equal(state.credentials.baiduSecret,true);assert.equal(state.credentials.baiduAccess,false);assert.equal(state.hasEncryptedCredentials,true);assert.equal(calls.filter(x=>x[0]==='flush-prefs').length,1);
 assert.doesNotMatch(values.get('credentialPresence'),/mock-cookie|mock-secret/);assert.doesNotMatch(values.get('config'),/mock-cookie|mock-secret/);
});
test('reading configuration status does not decrypt credentials or discard existing encrypted content',async()=>{
 const{rt,config,Zotero,values}=setup();await rt.saveSettings(config,{quarkCookie:'mock-cookie'});const cipher=values.get('credentials');Zotero.OSKeyStore.decrypt=async()=>{throw Error('must not decrypt for status');};
 assert.equal(rt.configurationState().credentials.quarkCookie,true);assert.equal(values.get('credentials'),cipher);
});
function fakeSession(rt,calls){
 const s={provider:{identity:'quark:folder123',dispose:async()=>calls.push(['dispose'])},dav:{tail:Promise.resolve(),failure:null},nativeErrors:[],cancelled:false};
 rt.startSession=async()=>{calls.push(['start']);rt.active=s;return s;};
 rt.stopSession=async()=>{calls.push(['close']);rt.active=null;};rt.hash=()=> 'target-hash';return s;
}
test('QR login encrypts only verified credentials and preserves other provider settings',async()=>{
 const f=setup();await f.rt.saveSettings(f.config,{quarkCookie:'OLD',baiduAccess:'BAIDU'});const savedConfig=f.values.get('config');let qrShown=false;
 f.rt.providers={QuarkQRLogin:class{async run(onQR){onQR('https://su.quark.cn/4_eMHBJ?token=MOCK');return '__puus=NEW';}}};
 await f.rt.loginQuark(()=>{qrShown=true;});assert.equal(qrShown,true);assert.equal((await f.rt.secrets()).quarkCookie,'__puus=NEW');assert.equal((await f.rt.secrets()).baiduAccess,'BAIDU');assert.equal(f.values.get('config'),savedConfig);assert.equal(f.rt.busy,false);assert.equal(f.rt.active,null);assert.equal(f.rt.loginCancel,null);assert.match(f.rt.status,/扫码登录成功/);assert.doesNotMatch(f.values.get('credentialPresence'),/__puus|NEW/);
});
test('failed or cancelled QR login never overwrites saved credentials',async()=>{
 for(const mode of ['protocol','cancel','encrypt']){
  const f=setup();await f.rt.saveSettings(f.config,{quarkCookie:'OLD'});const old=f.values.get('credentials');
  f.rt.providers={QuarkQRLogin:class{constructor(env,cancel){this.cancel=cancel;}async run(){if(mode==='protocol')throw new f.rt.core.CloudError('二维码过期');if(mode==='cancel')this.cancel.cancelled=true;return '__puus=NEW';}}};
  if(mode==='encrypt')f.Zotero.OSKeyStore.encrypt=async()=>{throw Error('PRIVATE_ERROR');};
  await assert.rejects(f.rt.loginQuark(()=>{}));assert.equal(f.values.get('credentials'),old);assert.equal(f.rt.busy,false);assert.equal(f.rt.loginCancel,null);assert.doesNotMatch(f.rt.status,/PRIVATE_ERROR|__puus/);
 }
});
test('QR cancellation aborts its request and prevents a late login commit',async()=>{
 const f=setup();await f.rt.saveSettings(f.config,{quarkCookie:'OLD'});const old=f.values.get('credentials');let finish,aborted=false;
 f.rt.providers={QuarkQRLogin:class{constructor(env,cancel){this.cancel=cancel;}async run(){this.cancel.abort=()=>{aborted=true;finish('__puus=LATE');};return new Promise(r=>finish=r);}}};
 const running=f.rt.loginQuark(()=>{});assert.equal(f.rt.busy,true);f.rt.cancelQuarkLogin();await assert.rejects(running,/取消/);assert.equal(aborted,true);assert.equal(f.values.get('credentials'),old);
});
test('QR login refuses to race synchronization or another login',async()=>{
 const f=setup();f.runner.syncInProgress=true;await assert.rejects(f.rt.loginQuark(()=>{}),/等待/);f.runner.syncInProgress=false;f.rt.busy=true;await assert.rejects(f.rt.loginQuark(()=>{}),/等待/);assert.equal(f.rt.loginCancel,null);
});
function baiduLoginNetwork(f,{failAccount=false,deviceError=false}={}){
 const requests=[];f.rt.request=async o=>{
  requests.push(o);const u=new URL(o.url);let body;
  if(u.pathname==='/oauth/2.0/device/code')body=deviceError?{error:'invalid_client'}:{device_code:'MOCK_DEVICE',user_code:'mock1234',expires_in:300,interval:5};
  else if(u.pathname==='/oauth/2.0/token')body={access_token:'NEW_ACCESS',refresh_token:'NEW_REFRESH',scope:'basic netdisk'};
  else if(u.pathname==='/rest/2.0/xpan/nas')body=failAccount?{errno:110}:{errno:0,uk:'12345678901234567890'};
  else throw Error('Unexpected URL');
  return {status:200,bytes:new TextEncoder().encode(JSON.stringify(body)),headers:{},cookies:[]};
 };return requests;
}
test('Baidu QR verifies tokens and encrypts app credentials without requiring a directory or changing Quark config',async()=>{
 const f=setup();await f.rt.saveSettings(f.config,{quarkCookie:'QUARK',baiduAccess:'OLD',baiduRefresh:'OLD_REFRESH'});const original=f.rt.config();const requests=baiduLoginNetwork(f);let shown=false;
 await f.rt.loginBaidu({client:'OWN_CLIENT',secret:'OWN_SECRET'},()=>shown=true);
 const saved=await f.rt.secrets();assert.equal(shown,true);assert.equal(saved.baiduAccess,'NEW_ACCESS');assert.equal(saved.baiduRefresh,'NEW_REFRESH');assert.equal(saved.baiduSecret,'OWN_SECRET');assert.equal(saved.quarkCookie,'QUARK');assert.equal(f.rt.config().provider,original.provider);assert.equal(f.rt.config().quarkFolder,original.quarkFolder);assert.equal(f.rt.config().baiduClient,'OWN_CLIENT');assert.equal(f.rt.configurationState().credentials.baiduAccess,true);assert.equal(requests.length,3);assert.equal(f.rt.active,null);assert.equal(f.rt.busy,false);assert.match(f.rt.status,/百度扫码授权成功/);assert.doesNotMatch(f.values.get('config'),/OWN_SECRET|NEW_ACCESS|NEW_REFRESH/);
});
test('Baidu QR can reuse saved SecretKey only for the same AppKey',async()=>{
 const f=setup();await f.rt.saveSettings({...f.config,baiduClient:'SAME'},{baiduSecret:'SAVED_SECRET'});const requests=baiduLoginNetwork(f);await f.rt.loginBaidu({client:'SAME',secret:''},()=>{});assert.equal(new URL(requests[1].url).searchParams.get('client_secret'),'SAVED_SECRET');
 const g=setup();await g.rt.saveSettings({...g.config,baiduClient:'OLD'},{baiduSecret:'OLD_SECRET'});const more=baiduLoginNetwork(g);await assert.rejects(g.rt.loginBaidu({client:'NEW',secret:''},()=>{}),/AppKey/);assert.equal(more.length,0);
});
test('Baidu QR account failure, OAuth rejection, and encryption failure preserve all prior settings and credentials',async()=>{
 for(const mode of ['account','oauth','encrypt']){
  const f=setup();await f.rt.saveSettings({...f.config,baiduClient:'OLD_CLIENT'},{baiduAccess:'OLD_ACCESS',baiduRefresh:'OLD_REFRESH',baiduSecret:'OLD_SECRET'});const cipher=f.values.get('credentials'),config=f.values.get('config');baiduLoginNetwork(f,{failAccount:mode==='account',deviceError:mode==='oauth'});
  if(mode==='encrypt')f.Zotero.OSKeyStore.encrypt=async()=>{throw Object.assign(Error('PRIVATE_TOKEN'),{name:'NS_ERROR_FAILURE'});};
  await assert.rejects(f.rt.loginBaidu({client:'NEW_CLIENT',secret:'NEW_SECRET'},()=>{}));assert.equal(f.values.get('credentials'),cipher);assert.equal(f.values.get('config'),config);assert.equal(f.rt.busy,false);assert.equal(f.rt.loginCancel,null);assert.doesNotMatch(f.rt.status,/PRIVATE_TOKEN|NEW_ACCESS|NEW_SECRET/);
 }
});
test('Baidu QR cancellation prevents a late verified result from committing',async()=>{
 const f=setup();await f.rt.saveSettings(f.config,{baiduAccess:'OLD'});const cipher=f.values.get('credentials');let ready;const started=new Promise(resolve=>ready=resolve);
 f.rt.providers={BaiduQRLogin:class{constructor(c,s,e,cancel){this.cancel=cancel;}async run(){return new Promise(resolve=>{this.cancel.abort=()=>resolve({baiduAccess:'LATE',baiduRefresh:'LATE_REFRESH'});ready();});}}};
 const running=f.rt.loginBaidu({client:'CLIENT',secret:'SECRET'},()=>{});await started;f.rt.cancelBaiduLogin();await assert.rejects(running,/取消/);assert.equal(f.values.get('credentials'),cipher);assert.equal(f.rt.busy,false);
});
test('Baidu QR refuses to race an active session, native sync, or another login',async()=>{
 const f=setup();f.rt.busy=true;await assert.rejects(f.rt.loginBaidu({client:'c',secret:'s'},()=>{}),/等待/);f.rt.busy=false;f.rt.active={};await assert.rejects(f.rt.loginBaidu({client:'c',secret:'s'},()=>{}),/等待/);f.rt.active=null;f.runner.syncInProgress=true;await assert.rejects(f.rt.loginBaidu({client:'c',secret:'s'},()=>{}),/等待/);
});
test('full Baidu device-code flow persists encrypted credentials before any WebDAV session starts',async()=>{
 const f=setup();await f.rt.saveSettings(f.config,{quarkCookie:'KEEP_QUARK'});f.rt.random=()=> 'mock-request';const requests=[];let shown;
 f.rt.request=async o=>{
  requests.push(o);const path=new URL(o.url).pathname;let result;
  if(path.endsWith('/device/code'))result={device_code:'MOCK_DEVICE',user_code:'mock1234',expires_in:300,interval:5};
  else if(path.endsWith('/oauth/2.0/token'))result={access_token:'NEW_ACCESS',refresh_token:'NEW_REFRESH',scope:'basic netdisk'};
  else if(path.endsWith('/xpan/nas'))result={errno:0,uk:'12345678901234567890'};
  else throw Error('Unexpected endpoint');
  return {status:200,bytes:new TextEncoder().encode(JSON.stringify(result)),headers:{},cookies:[]};
 };
 await f.rt.loginBaidu({client:'OWN_CLIENT',secret:'OWN_SECRET'},(url,code)=>shown={url,code});
 const saved=await f.rt.secrets(),qr=new URL(shown.url);assert.equal(qr.hostname,'openapi.baidu.com');assert.equal(qr.searchParams.get('code'),'mock1234');assert.equal(shown.code,'mock1234');assert.equal(saved.baiduAccess,'NEW_ACCESS');assert.equal(saved.baiduRefresh,'NEW_REFRESH');assert.equal(saved.baiduSecret,'OWN_SECRET');assert.equal(saved.quarkCookie,'KEEP_QUARK');assert.equal(f.rt.config().baiduClient,'OWN_CLIENT');assert.equal(f.rt.active,null);assert.equal(f.rt.busy,false);assert.equal(f.values.get('config').includes('OWN_SECRET'),false);assert.ok(f.values.get('credentials').startsWith('encrypted:'));assert.equal(requests.length,3);
});
test('full Baidu device-code failures preserve prior account and app settings',async()=>{
 for(const mode of ['denied','account','cancel']){
  const f=setup();await f.rt.saveSettings({...f.config,baiduClient:'OLD_CLIENT'},{baiduSecret:'OLD_SECRET',baiduAccess:'OLD_ACCESS',baiduRefresh:'OLD_REFRESH'});const encrypted=f.values.get('credentials'),config=f.values.get('config');f.rt.random=()=> 'mock';
  f.rt.request=async o=>{const path=new URL(o.url).pathname;let result;if(path.endsWith('/device/code'))result={device_code:'MOCK_DEVICE',user_code:'mock1234',expires_in:300,interval:5};else if(path.endsWith('/oauth/2.0/token')){if(mode==='denied')result={error:'access_denied'};else{result={access_token:'NEW_ACCESS',refresh_token:'NEW_REFRESH',scope:'basic netdisk'};if(mode==='cancel')f.rt.cancelBaiduLogin();}}else result={errno:110};return {status:200,bytes:new TextEncoder().encode(JSON.stringify(result)),headers:{},cookies:[]};};
  await assert.rejects(f.rt.loginBaidu({client:'NEW_CLIENT',secret:'NEW_SECRET'},()=>{}));assert.equal(f.values.get('credentials'),encrypted);assert.equal(f.values.get('config'),config);assert.equal(f.rt.active,null);assert.equal(f.rt.busy,false);assert.equal(f.rt.loginCancel,null);
 }
});
test('only Baidu login OAuth HTTP 400 responses are delivered for pending/denied state parsing',async()=>{
 const f=setup();f.ctx.ChromeUtils.generateQI=()=>()=>{};f.ctx.Components.interfaces={nsIRequest:{LOAD_BYPASS_CACHE:1},nsIHttpChannel:{}};
 class FakeXHR{constructor(){this.channel={loadFlags:0,QueryInterface:()=>this.channel,getResponseHeader:()=>''};this.status=400;this.response=new TextEncoder().encode('{"error":"authorization_pending"}').buffer;}open(){}setRequestHeader(){}getAllResponseHeaders(){return '';}send(){this.onload();}}
 f.ctx.XMLHttpRequest=FakeXHR;
 const r=await f.rt.request({provider:'baidu',kind:'login',url:'https://openapi.baidu.com/oauth/2.0/token'});assert.equal(r.status,400);assert.match(new TextDecoder().decode(r.bytes),/authorization_pending/);
 await assert.rejects(f.rt.request({provider:'baidu',kind:'login',url:'https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo'}),/HTTP 400/);
 await assert.rejects(f.rt.request({provider:'quark',kind:'login',url:'https://pan.quark.cn/account/info'}),/HTTP 400/);
});
test('actual QR provider with account code OK reaches encrypted persistence without starting WebDAV',async()=>{
 const f=setup();await f.rt.saveSettings(f.config,{quarkCookie:'OLD',baiduAccess:'BAIDU'});const requests=[];let displayed=false;
 f.rt.random=()=> 'fixture-request';
 f.rt.request=async o=>{
  const path=new URL(o.url).pathname;requests.push(path);let body,cookies=[];
  if(path.endsWith('getTokenForQrcodeLogin'))body={status:2000000,data:{members:{token:'MOCK_TOKEN'}}};
  else if(path.endsWith('getServiceTicketByQrcodeToken'))body={status:2000000,data:{members:{service_ticket:'MOCK_TICKET'}}};
  else if(path==='/account/info'){body={success:true,code:'OK'};cookies=['__puus=MOCK_VERIFIED; Domain=.quark.cn; Path=/; Secure'];}
  else if(path.endsWith('/file/sort')){assert.match(o.headers.Cookie,/__puus=MOCK_VERIFIED/);body={code:0,status:200,data:{list:[]}};}
  else throw Error('Unexpected endpoint');
  return {status:200,bytes:new TextEncoder().encode(JSON.stringify(body)),cookies,headers:{}};
 };
 await f.rt.loginQuark(()=>{displayed=true;});
 assert.equal(displayed,true);assert.equal(requests.length,4);assert.equal((await f.rt.secrets()).quarkCookie,'__puus=MOCK_VERIFIED');assert.equal((await f.rt.secrets()).baiduAccess,'BAIDU');assert.equal(f.rt.active,null);assert.equal(f.rt.busy,false);assert.match(f.rt.status,/扫码登录成功/);assert.ok(f.values.get('credentials').startsWith('encrypted:'));
});
test('actual QR provider cannot save an OK exchange when read-only directory verification fails',async()=>{
 const f=setup();await f.rt.saveSettings(f.config,{quarkCookie:'OLD'});const encrypted=f.values.get('credentials');f.rt.random=()=> 'fixture-request';
 f.rt.request=async o=>{
  const path=new URL(o.url).pathname;let body,cookies=[];
  if(path.endsWith('getTokenForQrcodeLogin'))body={status:2000000,data:{members:{token:'MOCK_TOKEN'}}};
  else if(path.endsWith('getServiceTicketByQrcodeToken'))body={status:2000000,data:{members:{service_ticket:'MOCK_TICKET'}}};
  else if(path==='/account/info'){body={success:true,code:'OK'};cookies=['__puus=MOCK_NEW; Domain=.quark.cn; Path=/; Secure'];}
  else body={code:15000,status:500};
  return {status:200,bytes:new TextEncoder().encode(JSON.stringify(body)),cookies,headers:{}};
 };
 await assert.rejects(f.rt.loginQuark(()=>{}),/读取验证失败/);assert.equal(f.values.get('credentials'),encrypted);assert.equal(f.rt.active,null);assert.equal(f.rt.busy,false);
});
test('real run lifecycle closes session after successful sync and prevents double sync',async()=>{
 const {rt,runner,calls}=setup();await rt.startup();fakeSession(rt,calls);await rt.run('sync');
 assert.equal(rt.active,null);assert.equal(rt.busy,false);assert.match(rt.status,/接口已关闭/);assert.deepEqual(calls.filter(x=>['start','sync','close'].includes(x[0])).map(x=>x[0]),['start','sync','close']);
 rt.busy=true;await assert.rejects(rt.run('sync'));assert.equal(await runner.sync(),false);rt.busy=false;await rt.shutdown();
});
test('sync error, cancellation and reset error all close the actual run session',async()=>{
 for(const stage of ['sync','cancel','reset','dav']){
  const {rt,calls,local}=setup();await rt.startup();const s=fakeSession(rt,calls);
  if(stage==='sync')rt.native.sync=async o=>o.onError(Error('sync failed'));
  if(stage==='cancel')rt.native.sync=async()=>{s.cancelled=true;};
  if(stage==='reset')local.resetAllSyncStates=async()=>{throw Error('reset failed');};
  if(stage==='dav')s.dav.failure=new rt.core.CloudError('remote write failed');
  await assert.rejects(rt.run('sync'));assert.ok(calls.some(x=>x[0]==='close'));assert.equal(rt.busy,false);assert.equal(rt.active,null);await rt.shutdown();
 }
});
test('test action also closes session on successful or failed cloud verification',async()=>{
 for(const fail of [false,true]){const{rt,calls}=setup();await rt.startup();fakeSession(rt,calls);rt.testSession=async()=>{if(fail)throw Error('test failed');};if(fail)await assert.rejects(rt.run('test'));else await rt.run('test');assert.equal(rt.active,null);assert.ok(calls.some(x=>x[0]==='close'));await rt.shutdown();}
});
test('run refuses to race with an existing native synchronization',async()=>{
 const {rt,runner,calls}=setup();await rt.startup();runner.syncInProgress=true;await assert.rejects(rt.run('sync'));assert.equal(calls.length,0);await rt.shutdown();
});
test('actual request transport labels Quark HTTP 500 without exposing response secrets',async()=>{
 const {rt,ctx}=setup();ctx.ChromeUtils.generateQI=()=>()=>{};ctx.Components.interfaces={nsIRequest:{LOAD_BYPASS_CACHE:1}};
 class FakeXHR{
  constructor(){this.channel={loadFlags:0};this.status=500;this.response=new TextEncoder().encode('{"code":500123,"message":"COOKIE_PRIVATE","access_token":"TOKEN_PRIVATE"}').buffer;}
  open(){}setRequestHeader(){}send(){this.onload();}
 }
 ctx.XMLHttpRequest=FakeXHR;
 await assert.rejects(rt.request({provider:'quark',kind:'api',method:'POST',url:'https://drive-pc.quark.cn/1/clouddrive/file/upload/pre?token=QUERY_PRIVATE',body:'{"cookie":"BODY_PRIVATE"}'}),e=>{assert.match(e.message,/夸克：预上传失败：HTTP 500/);assert.match(e.message,/code=500123/);assert.doesNotMatch(e.message,/COOKIE_PRIVATE|TOKEN_PRIVATE|QUERY_PRIVATE|BODY_PRIVATE/);return true;});
});
test('download HTTP 500 remains the primary failure when test-file cleanup also fails',async()=>{
 const {rt}=setup();rt.random=()=> 'test';
 const first=new rt.core.CloudError('夸克：下载文件失败：HTTP 500。');
 const dav={failure:null,handle:async req=>{if(req.method==='PUT')return {status:204};if(req.method==='GET'){dav.failure=first;return {status:502};}dav.failure=new rt.core.CloudError('cleanup HTTP 403');return {status:502};}};
 await assert.rejects(rt.testSession({dav,prefix:'/test/',auth:'mock'}),e=>{assert.match(e.message,/下载文件失败：HTTP 500/);assert.match(e.message,/清理失败/);return true;});
});
test('upload failure is reported without claiming a successful test or running later stages',async()=>{
 const {rt}=setup();rt.random=()=> 'test';const calls=[];
 const dav={failure:new rt.core.CloudError('夸克：预上传失败：HTTP 500。'),handle:async req=>{calls.push(req.method);return {status:502};}};
 await assert.rejects(rt.testSession({dav,prefix:'/test/',auth:'mock'}),/预上传失败：HTTP 500/);assert.deepEqual(calls,['PUT']);
});
test('Quark Cookie is set on privileged HTTP channel rather than silently ignored by XHR',async()=>{
 const{rt,ctx}=setup(),headers={};let sent=false;ctx.ChromeUtils.generateQI=()=>()=>{};ctx.Components.interfaces={nsIRequest:{LOAD_BYPASS_CACHE:1},nsIHttpChannel:{}};
 class FakeXHR{
  constructor(){this.channel={loadFlags:0,QueryInterface:()=>this.channel,setRequestHeader:(k,v)=>{headers[k]=v;},getRequestHeader:k=>headers[k],getResponseHeader:()=>''};this.status=200;this.response=new TextEncoder().encode('{"code":0}').buffer;}
  open(){}setRequestHeader(k){assert.notEqual(k,'Cookie');}getAllResponseHeaders(){return '';}send(){sent=true;this.onload();}
 }
 ctx.XMLHttpRequest=FakeXHR;await rt.request({provider:'quark',kind:'api',url:'https://drive-pc.quark.cn/1/clouddrive/config',headers:{Cookie:'mock-cookie',Referer:'https://pan.quark.cn/'}});assert.equal(headers.Cookie,'mock-cookie');assert.equal(sent,true);
});
test('a rejected authentication header stops before transmission without exposing its contents',async()=>{
 const{rt,ctx}=setup();let sent=false;ctx.ChromeUtils.generateQI=()=>()=>{};ctx.Components.interfaces={nsIRequest:{LOAD_BYPASS_CACHE:1},nsIHttpChannel:{}};
 class FakeXHR{constructor(){this.channel={loadFlags:0,QueryInterface:()=>{throw Error('blocked');}};}open(){}setRequestHeader(){}send(){sent=true;}}
 ctx.XMLHttpRequest=FakeXHR;await assert.rejects(rt.request({provider:'quark',kind:'api',url:'https://drive-pc.quark.cn/1/clouddrive/config',headers:{Cookie:'COOKIE_PRIVATE'}}),e=>{assert.match(e.message,/请求尚未发送/);assert.doesNotMatch(e.message,/COOKIE_PRIVATE/);return true;});assert.equal(sent,false);
});
test('sanitized runtime diagnostics retain stage, exception type and plugin line only',()=>{
 const {rt}=setup();const e=Object.assign(new Error('Cookie=PRIVATE; https://pan.quark.cn/?token=PRIVATE'),{name:'TypeError',status:403,result:0x80004005,stack:'upload@jar:file:///private/profile/plugin.xpi!/runtime.js:321:5\nhttps://pan.quark.cn/?token=PRIVATE:12:3'});
 const safe=rt.operationError(e,'Zotero 原生 WebDAV 验证');assert.match(safe.message,/Zotero 原生 WebDAV 验证/);assert.match(safe.message,/TypeError/);assert.match(safe.message,/runtime.js:321/);assert.match(safe.message,/HTTP 403/);assert.match(safe.message,/0x80004005/);assert.doesNotMatch(safe.message,/PRIVATE|profile|https|upload@/);
 const named=rt.operationError({name:'PRIVATE',stack:'PRIVATE',message:'PRIVATE',error:'FILE_MISSING_AFTER_UPLOAD'},'测试');assert.match(named.message,/FILE_MISSING_AFTER_UPLOAD/);assert.doesNotMatch(named.message,/PRIVATE/);
});
test('safe CloudErrors retain their original details in both display and task status',()=>{
 const {rt,Services}=setup();let alert;Services.prompt={alert:(win,title,msg)=>alert=msg};const e=new rt.core.CloudError('夸克：预上传失败：HTTP 500。');rt.showError(e,{});assert.equal(alert,e.message);assert.equal(rt.status,e.message);
 rt.showError(Object.assign(new Error('PRIVATE'),{name:'ReferenceError'}),{});assert.match(alert,/ReferenceError/);assert.doesNotMatch(alert,/PRIVATE/);
});
test('saving configuration exposes a storage stage without disclosing encryption errors',async()=>{
 const {rt,config,Zotero,values}=setup();Zotero.OSKeyStore.encrypt=async()=>{throw Object.assign(new Error('PRIVATE_COOKIE'),{name:'NS_ERROR_FAILURE'});};
 await assert.rejects(rt.saveSettings(config,{quarkCookie:'PRIVATE_COOKIE'}),e=>{assert.match(e.message,/保存本机配置/);assert.match(e.message,/NS_ERROR_FAILURE/);assert.doesNotMatch(e.message,/PRIVATE_COOKIE/);return true;});assert.equal(values.has('credentials'),false);
});
function sessionFixture({identityError=false}={}){
 const f=setup(),events=[],files=new Map();
 const provider={identity:'memory',init:async()=>events.push('init'),dispose:async()=>events.push('dispose'),ensureRoot:async()=>{},list:async()=>Array.from(files,([name,b])=>({name,size:b.length,dir:false})),stat:async name=>files.has(name)?{name,size:files.get(name).length,dir:false}:null,put:async(name,b)=>files.set(name,b),get:async name=>files.get(name),remove:async name=>files.delete(name)};
 let server;class HttpServer{
  constructor(){server=this;const locations=new Map();this.identity={primaryPort:24567,primaryHost:'localhost',setPrimary(scheme,host,port){if(identityError&&host==='127.0.0.1')throw Object.assign(new Error('PRIVATE'),{name:'NS_ERROR_FAILURE'});locations.set(host+':'+port,scheme);this.primaryHost=host;this.primaryPort=port;},getScheme:(host,port)=>locations.get(host+':'+port)||'',has:(scheme,host,port)=>locations.get(host+':'+port)===scheme};}
  registerPrefixHandler(path,handler){this.handler=handler;events.push('register');}
  _start(port,host){assert.equal(port,-1);assert.equal(host,'127.0.0.1');this.identity.setPrimary('http','localhost',24567);events.push('start');}
  async stop(){events.push('stop');}
 }
 f.rt.providers={create:()=>provider};f.ctx.ChromeUtils.importESModule=uri=>{assert.equal(uri,'chrome://remote/content/server/httpd.sys.mjs');return {HttpServer};};f.ctx.btoa=s=>Buffer.from(s,'binary').toString('base64');f.rt.random=()=> 'abcdef';
 return {...f,provider,events,files,getServer:()=>server};
}
test('real startSession and stopSession setup bind only loopback and dispose the provider',async()=>{
 const f=sessionFixture();const s=await f.rt.startSession(f.config);assert.equal(f.rt.active,s);assert.match(s.base,/^http:\/\/127\.0\.0\.1:24567\/abcdef\/$/);assert.deepEqual(f.events,['init','register','start']);await f.rt.stopSession(s);assert.equal(f.rt.active,null);assert.equal(s.auth,'');assert.deepEqual(f.events,['init','register','start','stop','dispose']);
});
test('numeric loopback is registered before the first native request instead of failing Host validation with 400',async()=>{
 const f=sessionFixture(),s=await f.rt.startSession(f.config),server=f.getServer(),u=new URL(s.base);
 assert.equal(server.identity.primaryHost,'127.0.0.1');assert.equal(server.identity.getScheme(u.hostname,Number(u.port)),'http');assert.equal(server.identity.has('http','127.0.0.1',24567),true);
 assert.equal(server.identity.getScheme('attacker.test',24567),'');assert.equal(server.identity.getScheme('127.0.0.1',24568),'');
 // Model httpd's pre-handler Host gate, then run our actual native callback.
 async function dispatch(host,authorization){
  const split=host.lastIndexOf(':'),hostname=host.slice(0,split),port=Number(host.slice(split+1));
  if(!server.identity.getScheme(hostname,port))return 400;
  return new Promise(resolve=>{let status;const headers={host,...(authorization?{authorization}:{})};server.handler({method:'OPTIONS',path:s.prefix+'zotero/',httpVersion:'1.1',hasHeader:k=>k in headers,getHeader:k=>headers[k]},{processAsync(){},setStatusLine:(v,n)=>status=n,setHeader(){},finish:()=>resolve(status)});});
 }
 assert.equal(await dispatch(u.host,s.auth),200);assert.equal(await dispatch(u.host),401);assert.equal(await dispatch('attacker.test:24567',s.auth),400);
 // Registered localhost must still fail the bridge's exact Host check.
 assert.equal(await dispatch('localhost:24567',s.auth),403);
 await f.rt.stopSession(s);assert.equal(f.rt.active,null);
});
test('server module import failure disposes provider and identifies failing stage',async()=>{
 const f=sessionFixture();f.ctx.ChromeUtils.importESModule=()=>{throw Object.assign(new Error('PRIVATE_URL'),{name:'NS_ERROR_FILE_NOT_FOUND'});};await assert.rejects(f.rt.startSession(f.config),e=>{assert.match(e.message,/加载本地 WebDAV 组件/);assert.match(e.message,/NS_ERROR_FILE_NOT_FOUND/);assert.doesNotMatch(e.message,/PRIVATE_URL/);return true;});assert.deepEqual(f.events,['init','dispose']);assert.equal(f.rt.active,null);
});
test('identity registration failure stops its already-open listener before disposing the provider',async()=>{
 const f=sessionFixture({identityError:true});await assert.rejects(f.rt.startSession(f.config),e=>{assert.match(e.message,/本机临时 WebDAV/);assert.doesNotMatch(e.message,/PRIVATE/);return true;});assert.deepEqual(f.events,['init','register','start','stop','dispose']);assert.equal(f.rt.active,null);
});
test('provider parsing failure identifies directory stage and releases in-memory credentials',async()=>{
 const f=sessionFixture();f.provider.init=async()=>{throw Object.assign(new Error('PRIVATE_RESPONSE'),{name:'SyntaxError'});};await assert.rejects(f.rt.startSession(f.config),e=>{assert.match(e.message,/网盘登录与专用目录检查/);assert.match(e.message,/SyntaxError/);assert.doesNotMatch(e.message,/PRIVATE_RESPONSE/);return true;});assert.deepEqual(f.events,['dispose']);
});
test('native verification failures preserve safe verifier code and leave no active session',async()=>{
 const f=sessionFixture();f.Zotero.Sync.Storage.Mode.WebDAV.prototype.checkServer=async()=>{throw Object.assign(new Error('PRIVATE_URL'),{error:'NOT_DAV'});};
 await assert.rejects(f.rt.run('test'),e=>{assert.match(e.message,/Zotero 原生 WebDAV 验证/);assert.match(e.message,/NOT_DAV/);assert.doesNotMatch(e.message,/PRIVATE_URL/);return true;});assert.equal(f.files.size,0);assert.equal(f.rt.active,null);assert.equal(f.rt.busy,false);assert.ok(f.events.includes('stop'));assert.ok(f.events.includes('dispose'));
});
test('cleanup failures do not replace the primary failure and keep an unclosed listener visible',async()=>{
 const f=sessionFixture();const first=new f.rt.core.CloudError('夸克：下载文件失败：HTTP 500。');
 f.rt.testSession=async()=>{f.getServer().stop=async()=>{throw Object.assign(new Error('PRIVATE'),{name:'NS_ERROR_FAILURE'});};throw first;};
 await assert.rejects(f.rt.run('test'),e=>{assert.match(e.message,/下载文件失败：HTTP 500/);assert.match(e.message,/关闭本地 WebDAV 服务/);assert.doesNotMatch(e.message,/PRIVATE/);return true;});assert.ok(f.rt.active);assert.match(f.rt.status,/仍在清理/);assert.equal(f.rt.busy,false);await assert.rejects(f.rt.run('test'),/重启 Zotero/);f.getServer().stop=async()=>{};await f.rt.stopSession(f.rt.active);assert.equal(f.rt.active,null);
});
test('synchronous network setup failures retain the fixed request stage without request secrets',async()=>{
 const f=setup();f.ctx.XMLHttpRequest=class{constructor(){throw Object.assign(new Error('PRIVATE_COOKIE'),{name:'TypeError'});}};
 await assert.rejects(f.rt.request({provider:'quark',kind:'api',url:'https://drive-pc.quark.cn/1/clouddrive/config?token=PRIVATE_TOKEN'}),e=>{assert.match(e.message,/登录状态检查/);assert.match(e.message,/TypeError/);assert.doesNotMatch(e.message,/PRIVATE/);return true;});
});
test('shutdown retries closing a retained listener after a failed task cleanup',async()=>{
 const f=sessionFixture();const s=await f.rt.startSession(f.config);assert.equal(f.rt.busy,false);await f.rt.shutdown();assert.equal(f.rt.active,null);assert.equal(s.auth,'');assert.ok(f.events.includes('stop'));assert.ok(f.events.includes('dispose'));
});

test('settings can receive a sanitized inline error without opening an alert',()=>{
 const {rt,Services}=setup();let alerts=0,updates=0;
 Services.prompt={alert:()=>alerts++};
 rt.settingsWindow={Event:class{constructor(type){this.type=type;}},dispatchEvent(e){assert.equal(e.type,'cloud-state');updates++;}};
 rt.showError(new TypeError('PRIVATE'),{},{inline:true});
 assert.equal(alerts,0);assert.equal(updates,1);assert.equal(rt.statusTone,'error');
 assert.match(rt.status,/TypeError/);assert.doesNotMatch(rt.status,/PRIVATE/);
});

test('saving a Quark path migrates local preferences without resolving it online',async()=>{
 const {rt,values,calls,config}=setup();
 await rt.saveSettings(config,{});
 const {quarkFolder,...settings}=config;
 await rt.saveSettings({...settings,quarkPath:''},{});
 assert.equal(rt.config().quarkFolder,quarkFolder);
 await assert.rejects(rt.saveSettings({...settings,quarkPath:'/'},{}),/专用目录/);
 assert.equal(rt.config().quarkFolder,quarkFolder);
 await rt.saveSettings({...settings,quarkPath:'/文献/Zotero'},{});
 assert.equal(rt.config().quarkPath,'/文献/Zotero');
 assert.equal(Object.hasOwn(JSON.parse(values.get('config')),'quarkFolder'),false);
 await assert.rejects(rt.saveSettings({...settings,quarkPath:''},{}),/专用目录/);
 assert.equal(rt.config().quarkPath,'/文献/Zotero');
 assert.deepEqual(calls.map(c=>c[0]),['flush-prefs','flush-prefs','flush-prefs']);
});
