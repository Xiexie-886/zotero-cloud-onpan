const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
const context=vm.createContext({URL,URLSearchParams,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,console});
for(const name of ['core.js','providers.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context);
const C=context.CloudCore,P=context.CloudProviders;
const bytes=s=>new TextEncoder().encode(s),text=b=>new TextDecoder().decode(b);
const result=j=>({status:200,bytes:bytes(JSON.stringify(j)),headers:{},cookies:[]});
const hash=(type,b,enc='hex')=>crypto.createHash(type).update(b).digest(enc);
const envBase={hash,base64:b=>Buffer.from(b).toString('base64'),random:()=>crypto.randomUUID().replaceAll('-',''),delay:async()=>{},saveSecrets:async()=>{}};

function baiduQRFixture({polls=[],devicePatch={},info={errno:0,uk:'12345678901234567890'},tokenPatch={}}={}){
 const calls=[],waits=[],cancel={cancelled:false};let index=0;
 const login=new P.BaiduQRLogin({baiduClient:'OWN_CLIENT'},{baiduSecret:'OWN_SECRET'},{...envBase,delay:async ms=>waits.push(ms),request:async o=>{
  calls.push(o);const u=new URL(o.url);
  if(u.pathname==='/oauth/2.0/device/code')return result({device_code:'MOCK_DEVICE',user_code:'mock1234',expires_in:300,interval:5,qrcode_url:'https://evil.test/qr',...devicePatch});
  if(u.pathname==='/oauth/2.0/token')return result(index<polls.length?polls[index++]:{access_token:'MOCK_ACCESS',refresh_token:'MOCK_REFRESH',scope:'basic netdisk',...tokenPatch});
  if(u.pathname==='/rest/2.0/xpan/nas')return result(info);
  throw Error('Unexpected URL');
 }},cancel);
 return {login,calls,waits,cancel};
}
test('Baidu QR uses official device-code flow and returns tokens only after read-only account verification',async()=>{
 const f=baiduQRFixture();let shown,user;const tokens=await f.login.run((url,code)=>{shown=url;user=code;});
 assert.equal(tokens.baiduAccess,'MOCK_ACCESS');assert.equal(tokens.baiduRefresh,'MOCK_REFRESH');assert.equal(f.calls.length,3);assert.deepEqual(f.waits,[5000]);
 const qr=new URL(shown);assert.equal(qr.origin,'https://openapi.baidu.com');assert.equal(qr.pathname,'/device');assert.equal(qr.searchParams.get('display'),'mobile');assert.equal(qr.searchParams.get('code'),user);assert.equal(user,'mock1234');assert.doesNotMatch(shown,/MOCK_DEVICE|OWN_SECRET|evil/);
 const request=new URL(f.calls[0].url);assert.equal(request.searchParams.get('response_type'),'device_code');assert.equal(request.searchParams.get('scope'),'basic,netdisk');assert.equal(request.searchParams.get('client_id'),'OWN_CLIENT');assert.equal(request.searchParams.has('client_secret'),false);
 const token=new URL(f.calls[1].url);assert.equal(token.searchParams.get('grant_type'),'device_token');assert.equal(token.searchParams.get('code'),'MOCK_DEVICE');assert.equal(token.searchParams.get('client_secret'),'OWN_SECRET');assert.ok(f.calls.every(o=>o.method==='GET'&&o.kind==='login'&&!o.headers.Cookie));assert.equal(Object.keys(f.login.secrets).length,0);
});
test('Baidu QR waits for confirmation and backs off on slow_down',async()=>{
 const f=baiduQRFixture({polls:[{error:'authorization_pending'},{error:'slow_down'}]});await f.login.run(()=>{});assert.deepEqual(f.waits,[5000,5000,10000]);assert.equal(f.calls.length,5);
});
test('Baidu QR respects server intervals without polling faster than five seconds',async()=>{
 for(const [interval,expected]of [[1,5000],[0,5000],[8,8000]]){const f=baiduQRFixture({devicePatch:{interval}});await f.login.run(()=>{});assert.equal(f.waits[0],expected);}
});
test('Baidu QR refuses missing app credentials before connecting',async()=>{
 for(const [client,secret]of [['','secret'],['client',''],['client',null]]){const f=baiduQRFixture();f.login.config.baiduClient=client;f.login.secrets.baiduSecret=secret;await assert.rejects(f.login.run(()=>{}),/AppKey/);assert.equal(f.calls.length,0);}
});
test('Baidu QR cancellation stops polling and clears temporary secrets',async()=>{
 const f=baiduQRFixture();await assert.rejects(f.login.run(()=>{f.cancel.cancelled=true;}),/取消/);assert.equal(f.calls.length,1);assert.equal(Object.keys(f.login.secrets).length,0);
});
test('Baidu QR expired or denied authorization never accesses the account API',async()=>{
 for(const error of ['expired_token','expired_device_code','access_denied','authorization_declined','invalid_client','invalid_scope','PRIVATE_ERROR']){
  const f=baiduQRFixture({polls:[{error,error_description:'PRIVATE_RESPONSE'}]});await assert.rejects(f.login.run(()=>{}),e=>{assert.doesNotMatch(e.message,/PRIVATE_ERROR|PRIVATE_RESPONSE|OWN_SECRET|MOCK_DEVICE/);return true;});assert.equal(f.calls.length,2);
 }
});
test('Baidu QR rejects incomplete tokens, missing netdisk scope, and invalid account verification',async()=>{
 for(const tokenPatch of [{access_token:''},{refresh_token:''},{scope:'basic'},{access_token:'bad\r\nheader'}]){const f=baiduQRFixture({tokenPatch});await assert.rejects(f.login.run(()=>{}));assert.equal(f.calls.length,2);}
 for(const info of [{errno:110},{errno:0},{error_code:111,uk:'123'}]){const f=baiduQRFixture({info});await assert.rejects(f.login.run(()=>{}),/账号验证失败/);assert.equal(f.calls.length,3);}
});
test('Baidu QR rejects malformed device data before displaying or polling',async()=>{
 for(const devicePatch of [{device_code:''},{user_code:'bad&code'},{expires_in:0},{interval:-1},{expires_in:3601}]){const f=baiduQRFixture({devicePatch});let shown=false;await assert.rejects(f.login.run(()=>shown=true));assert.equal(shown,false);assert.equal(f.calls.length,1);}
});
test('Baidu QR expiry stops before requesting a token after the deadline',async()=>{
 const f=baiduQRFixture({devicePatch:{expires_in:1}});const original=context.Date;let now=1000;context.Date={now:()=>now};f.login.env.delay=async()=>now+=2000;
 try{await assert.rejects(f.login.run(()=>{}),/过期/);assert.equal(f.calls.length,1);}finally{if(original===undefined)delete context.Date;else context.Date=original;}
});
test('Baidu login allows only exact official authorization and account verification endpoints',()=>{
 for(const url of ['https://openapi.baidu.com/oauth/2.0/device/code','https://openapi.baidu.com/oauth/2.0/token','https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo'])assert.doesNotThrow(()=>C.validateURL(url,'baidu','login'));
 for(const url of ['https://evil.test/oauth/2.0/token','https://fake.openapi.baidu.com/oauth/2.0/token','https://pan.baidu.com/rest/2.0/xpan/file?method=delete','https://pan.baidu.com/rest/2.0/xpan/nas?method=other','http://openapi.baidu.com/oauth/2.0/token'])assert.throws(()=>C.validateURL(url,'baidu','login'));
 const e=C.httpFailure({provider:'baidu',kind:'login',url:'https://openapi.baidu.com/oauth/2.0/token?code=PRIVATE_DEVICE&client_secret=PRIVATE_SECRET'},500,bytes('{"error_description":"PRIVATE_RESPONSE"}'));assert.match(e.message,/百度：等待扫码授权/);assert.doesNotMatch(e.message,/PRIVATE/);
});

function qrFixture({poll=2000000,folderError=false,accountError=false,accountCode='OK',accountResponse,missingCookie=false}={}) {
 const calls=[],cancel={cancelled:false};
 const login=new P.QuarkQRLogin({...envBase,request:async o=>{
  calls.push(o);const u=new URL(o.url);
  if(u.pathname.endsWith('getTokenForQrcodeLogin'))return {...result({status:2000000,data:{members:{token:'MOCK_TOKEN'}}}),cookies:['UOP=temporary; Domain=uop.quark.cn; Path=/; Secure']};
  if(u.pathname.endsWith('getServiceTicketByQrcodeToken'))return result({status:poll,data:{members:{service_ticket:'MOCK_TICKET'}}});
  if(u.pathname==='/account/info')return {...result(accountResponse===undefined?{success:!accountError,code:accountError?1:accountCode}:accountResponse),cookies:missingCookie?[]:['__pus=MOCK_PUS; Domain=.quark.cn; Path=/; Secure','__puus=MOCK_PUUS; Domain=.quark.cn; Path=/; Secure']};
  if(u.pathname.endsWith('/file/sort'))return result({status:200,code:folderError?15000:0,data:{list:[]}});
  throw Error('unexpected endpoint');
 }},cancel);
 return {calls,cancel,login};
}
test('Quark QR uses official endpoints and verifies read-only access before returning credential',async()=>{
 const f=qrFixture();let shown;const cookie=await f.login.run(u=>shown=u);
 assert.match(cookie,/__puus=MOCK_PUUS/);assert.doesNotMatch(cookie,/UOP/);assert.equal(f.calls.length,4);assert.ok(f.calls.every(o=>o.kind==='login'&&o.method==='GET'));
 const qr=new URL(shown);assert.equal(qr.hostname,'su.quark.cn');assert.equal(qr.searchParams.get('token'),'MOCK_TOKEN');
 const first=new URL(f.calls[0].url);assert.equal(first.searchParams.get('client_id'),'532');assert.equal(first.searchParams.get('v'),'1.2');assert.ok(first.searchParams.get('request_id'));
 assert.match(f.calls[1].headers.Cookie,/UOP=temporary/);assert.equal(f.calls[2].headers.Cookie,undefined);assert.match(f.calls[3].headers.Cookie,/__pus=MOCK_PUS/);assert.equal(new URL(f.calls[3].url).searchParams.get('_size'),'1');assert.equal(f.login.cookies.length,0);
});
test('QR account exchange accepts explicit OK or zero codes and still verifies drive access',async()=>{
 for(const accountCode of ['OK',0,'0']){
  const f=qrFixture({accountCode});assert.match(await f.login.run(()=>{}),/__puus=MOCK_PUUS/);assert.equal(f.calls.length,4);assert.equal(new URL(f.calls[3].url).pathname,'/1/clouddrive/file/sort');
 }
});
test('QR exchange rejects false success or unknown codes before any directory request',async()=>{
 for(const accountCode of ['PRIVATE_TOKEN',500,false,null,{},[],true]){
  const f=qrFixture({accountCode});await assert.rejects(f.login.run(()=>{}),e=>{assert.doesNotMatch(e.message,/PRIVATE_TOKEN|MOCK_TOKEN|MOCK_TICKET|MOCK_PUS|MOCK_PUUS/);return true;});assert.equal(f.calls.length,3);assert.equal(f.login.cookies.length,0);
 }
 const f=qrFixture({accountError:true});await assert.rejects(f.login.run(()=>{}));assert.equal(f.calls.length,3);
});
test('QR account response permits the explicit Status OK variant but never invents success',async()=>{
 const good=qrFixture({accountResponse:{success:true,Status:'OK'}});assert.match(await good.login.run(()=>{}),/__puus=MOCK_PUUS/);assert.equal(good.calls.length,4);
 for(const accountResponse of [{success:false,code:'OK'},{success:'false',code:'OK'},{code:'OK'},{success:true},{success:true,code:500,Status:'OK'},{success:true,code:null},null]){
  const f=qrFixture({accountResponse});await assert.rejects(f.login.run(()=>{}),/凭据交换失败/);assert.equal(f.calls.length,3);assert.equal(f.login.cookies.length,0);
 }
});
test('QR account rejection reports only a safe numeric code without response text or secrets',async()=>{
 const f=qrFixture({accountResponse:{success:false,code:31001,msg:'PRIVATE_TOKEN',data:{cookie:'PRIVATE_COOKIE'}}});
 await assert.rejects(f.login.run(()=>{}),e=>{assert.match(e.message,/扫码已确认/);assert.match(e.message,/code=31001/);assert.doesNotMatch(e.message,/PRIVATE_TOKEN|PRIVATE_COOKIE|MOCK_TICKET|MOCK_PUUS/);return true;});
 assert.equal(f.calls.length,3);assert.equal(f.login.cookies.length,0);
});
test('QR expiry stops without receiving credentials or accessing files',async()=>{
 const f=qrFixture({poll:50004002});await assert.rejects(f.login.run(()=>{}),/过期/);assert.equal(f.calls.length,2);assert.equal(f.login.cookies.length,0);
});
test('QR cancellation prevents further requests and drops temporary cookies',async()=>{
 const f=qrFixture({poll:50004001});await assert.rejects(f.login.run(()=>{f.cancel.cancelled=true;}),/取消/);assert.equal(f.calls.length,1);assert.equal(f.login.cookies.length,0);
});
test('QR waiting is sequential and does not accept a pending response as success',async()=>{
 const f=qrFixture({poll:50004001});let waits=0;f.login.env.delay=async()=>{if(++waits===2)f.cancel.cancelled=true;};await assert.rejects(f.login.run(()=>{}),/取消/);assert.equal(f.calls.length,2);
});
test('QR account failure, file verification failure and incomplete cookies never return a credential',async()=>{
 for(const options of [{accountError:true},{folderError:true},{missingCookie:true}]){const f=qrFixture(options);await assert.rejects(f.login.run(()=>{}));assert.equal(f.login.cookies.length,0);}
});
test('temporary QR cookies respect domain, host-only, path, expiry and replacement',()=>{
 const f=qrFixture(),url='https://pan.quark.cn/account/info';
 f.login.absorb(url,['a=one; Path=/account','b=two; Domain=.quark.cn; Path=/','bad=x; Domain=evil.test','public=x; Domain=cn','deleted=x; Max-Age=0','expired=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
 assert.match(f.login.cookie(url),/a=one/);assert.equal(f.login.cookie('https://drive-pc.quark.cn/1/clouddrive/file/sort'),'b=two');assert.equal(f.login.cookie('https://pan.quark.cn/accounting'),'b=two');
 f.login.absorb(url,['b=next; Domain=.quark.cn; Path=/']);assert.equal(f.login.cookie('https://drive-pc.quark.cn/'),'b=next');
});
test('login URL allowlist limits host and path without widening file API domains',()=>{
 for(const url of ['https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin','https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken','https://pan.quark.cn/account/info','https://drive-pc.quark.cn/1/clouddrive/file/sort'])assert.doesNotThrow(()=>C.validateURL(url,'quark','login'));
 for(const url of ['https://evil.test/account/info','https://pan.quark.cn/account/logout','https://uop.quark.cn/other','https://fake.uop.quark.cn/cas/ajax/getTokenForQrcodeLogin'])assert.throws(()=>C.validateURL(url,'quark','login'));
 assert.throws(()=>C.validateURL('https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin','quark','api'));
 const e=C.httpFailure({provider:'quark',kind:'login',url:'https://pan.quark.cn/account/info?st=PRIVATE_TICKET'},500,bytes('{"message":"PRIVATE_COOKIE"}'));assert.match(e.message,/完成扫码授权/);assert.doesNotMatch(e.message,/PRIVATE/);
});
test('HTTP diagnostics identify Quark API stages without including URL query or file IDs',()=>{
 assert.equal(C.requestStage({provider:'quark',kind:'api',url:'https://drive-pc.quark.cn/1/clouddrive/file/upload/auth?task_id=PRIVATE'}),'夸克：申请上传签名');
 assert.equal(C.requestStage({provider:'quark',kind:'download',url:'https://download.quark.cn/private/path?token=PRIVATE'}),'夸克：下载文件');
 assert.equal(C.requestStage({provider:'quark',kind:'upload',method:'POST',url:'https://bucket.aliyuncs.com/private?uploadId=PRIVATE'}),'夸克：合并上传分片');
});
test('HTTP 500 diagnostics expose only numeric service codes and never raw response contents',()=>{
 const e=C.httpFailure({provider:'quark',kind:'api',url:'https://drive-pc.quark.cn/1/clouddrive/file/upload/pre?cookie=PRIVATE'},500,bytes(JSON.stringify({code:500,status:500,message:'Cookie=PRIVATE',access_token:'SECRET',errno:'-6'})));
 assert.match(e.message,/夸克：预上传/);assert.match(e.message,/HTTP 500/);assert.match(e.message,/errno=-6/);assert.equal(e.httpStatus,500);assert.doesNotMatch(e.message,/PRIVATE|SECRET|Cookie|access_token/);
 const other=C.httpFailure({provider:'quark',kind:'api',url:'https://drive-pc.quark.cn/1/clouddrive/config'},500,bytes('{"code":"secret-token","message":"private"}'));assert.doesNotMatch(other.message,/secret-token|private/);
});
test('OSS errors expose only recognized symbolic codes without returning request bodies',()=>{
 const options={provider:'quark',kind:'upload',method:'PUT',url:'https://bucket.aliyuncs.com/private?token=PRIVATE'};
 const e=C.httpFailure(options,403,bytes('<Error><Code>SignatureDoesNotMatch</Code><Message>SECRET</Message></Error>'));assert.match(e.message,/OSS=SignatureDoesNotMatch/);assert.doesNotMatch(e.message,/SECRET|PRIVATE/);
 const unknown=C.httpFailure(options,500,bytes('<Code>SecretPassword</Code>'));assert.doesNotMatch(unknown.message,/SecretPassword/);
});
class Memory {
 constructor(){this.files=new Map();this.active=0;this.peak=0;}
 async ensureRoot(){}
 async list(){return Array.from(this.files,([name,b])=>({name,size:b.length,modified:1700000000000,dir:false}));}
 async stat(name){return (await this.list()).find(f=>f.name===name)||null;}
 async put(name,b){this.active++;this.peak=Math.max(this.peak,this.active);await new Promise(r=>setImmediate(r));this.files.set(name,new Uint8Array(b));this.active--;}
 async get(name){return this.files.get(name);}
 async remove(name){this.files.delete(name);}
}
function dav(provider=new Memory(),limit=1048576){return new C.DAV(provider,{prefix:'/secret/',authorization:'Basic token',maxBytes:limit});}
function req(d,method,name='',body,headers={}) {return d.handle({method,path:'/secret/zotero/'+name,body,headers:{authorization:'Basic token',...headers}});}
test('DAV authentication and browser origin protection',async()=>{
 const d=dav();assert.equal((await d.handle({method:'GET',path:'/secret/zotero/'})).status,401);
 assert.equal((await req(d,'GET','ABCDEFGH.zip',null,{origin:'https://attacker.test'})).status,403);
 assert.equal((await req(d,'OPTIONS')).headers.DAV,'1');
});
test('namespace restrictions reject traversal and arbitrary files',async()=>{
 for(const suffix of ['../private','zotero/%2e%2e%2fsecrets','zotero/%252e%252e%252fprivate','zotero/subdir/file.zip','zotero/a.zip','zotero/ABCDEFGH.zip/'])assert.throws(()=>C.parsePath('/secret/'+suffix,'/secret/'));
 assert.throws(()=>C.parsePath('/other/zotero/ABCDEFGH.zip','/secret/'));
 assert.equal(C.parsePath('/secret/zotero/ABCDEFGH.zip','/secret/').name,'ABCDEFGH.zip');
 assert.equal((await req(dav(),'DELETE')).status,403);
});
test('binary roundtrip, HEAD, DELETE and missing-file semantics',async()=>{
 const d=dav(),b=Uint8Array.of(0,255,128,10,13,0,37);
 assert.equal((await req(d,'GET','ABCDEFGH.zip')).status,404);
 assert.equal((await req(d,'PUT','ABCDEFGH.zip',b)).status,204);
 assert.deepEqual(Array.from((await req(d,'GET','ABCDEFGH.zip')).body),Array.from(b));
 const head=await req(d,'HEAD','ABCDEFGH.zip');assert.equal(head.headers['Content-Length'],'7');assert.equal(head.body,undefined);
 assert.equal((await req(d,'DELETE','ABCDEFGH.zip')).status,204);assert.equal((await req(d,'GET','ABCDEFGH.zip')).status,404);
});
test('PROPFIND returns DAV XML and filters unrelated files',async()=>{
 const p=new Memory();p.files.set('ABCDEFGH.zip',bytes('pdf'));p.files.set('private.txt',bytes('secret'));
 const d=dav(p),r=await req(d,'PROPFIND','',null,{depth:'1'});
 assert.equal(r.status,207);assert.ok(text(r.body).includes('<D:collection/>'));assert.match(text(r.body),/ABCDEFGH.zip/);assert.doesNotMatch(text(r.body),/private.txt/);
 assert.equal((await req(d,'PROPFIND','',null,{depth:'infinity'})).status,403);
});
test('serialized uploads and drain close the operation queue',async()=>{
 const p=new Memory(),d=dav(p);await Promise.all([req(d,'PUT','AAAAAAAA.zip',bytes('1')),req(d,'PUT','BBBBBBBB.zip',bytes('2'))]);
 assert.equal(p.peak,1);await d.drain();assert.equal((await req(d,'PUT','CCCCCCCC.zip',bytes('3'))).status,503);
});
test('size limit and remote errors never report success or expose raw exception',async()=>{
 const d=dav(new Memory(),3);assert.equal((await req(d,'PUT','AAAAAAAA.zip',bytes('1234'))).status,413);assert.equal((await req(d,'PUT','AAAAAAAA.zip',bytes(''))).status,400);
 const p=new Memory();p.put=async()=>{throw new Error('token=SECRET');};const failing=dav(p);
 const r=await req(failing,'PUT','AAAAAAAA.zip',bytes('a'));assert.equal(r.status,502);assert.doesNotMatch(text(r.body),/SECRET/);assert.ok(failing.failure);
});
test('folders masquerading as attachment files cannot be deleted',async()=>{
 const p=new Memory();p.stat=async()=>({name:'ABCDEFGH.zip',dir:true,size:0});p.remove=async()=>{throw Error('must not execute');};assert.equal((await req(dav(p),'DELETE','ABCDEFGH.zip')).status,403);
});
test('config and domain validation reject insecure targets',()=>{
 const base={provider:'quark',quarkFolder:'folder123',maxMB:64};C.validateConfig(base);
 for(const value of ['0','','../files'])assert.throws(()=>C.validateConfig({...base,quarkFolder:value}));
 for(const p of ['/','relative','/apps/a/../b','/apps/a/','/apps/a?x'])assert.throws(()=>C.validateConfig({provider:'baidu',baiduFolder:p,maxMB:64}));
 for(const u of ['http://drive-pc.quark.cn/','https://drive-pc.quark.cn.evil.org/','https://evilquark.cn/','https://user:pass@drive-pc.quark.cn/','https://drive-pc.quark.cn:8080/'])assert.throws(()=>C.validateURL(u,'quark'));
 C.validateURL('https://drive-pc.quark.cn/1/clouddrive/file','quark');C.validateURL('https://bucket.oss-cn-hangzhou.aliyuncs.com/file','quark','upload');assert.throws(()=>C.validateURL('https://bucket.aliyuncs.com.evil.org/file','quark','upload'));
});
test('Baidu long file IDs retain integer precision',()=>{
 const j=P.parseJSON('{"list":[{"fs_id":9223372036854775807}],"uk":1234567890123456789,"size":123}');assert.equal(j.list[0].fs_id,'9223372036854775807');assert.equal(j.uk,'1234567890123456789');assert.equal(j.size,123);
});
test('Baidu token refresh uses official endpoints and saves rotated tokens',async()=>{
 const requests=[];let saved;const env={...envBase,saveSecrets:async s=>saved={...s},request:async r=>{
  requests.push(r);if(r.url.includes('/oauth/'))return result({access_token:'new-access',refresh_token:'new-refresh'});if(new URL(r.url).searchParams.get('access_token')==='old')return result({errno:111});return result({errno:0,list:[]});
 }};
 const p=new P.Baidu({baiduClient:'my-client'},{baiduAccess:'old',baiduRefresh:'old-refresh',baiduSecret:'own-secret'},env);await p.api('/xpan/file','GET',{method:'list',dir:'/apps/test'});assert.equal(saved.baiduAccess,'new-access');assert.equal(requests.length,3);assert.equal(new URL(requests[1].url).hostname,'openapi.baidu.com');assert.match(requests[1].body,/client_secret=own-secret/);
});
test('Baidu multipart upload validates MD5 before committing and confirming file',async()=>{
 const content=Uint8Array.of(0,1,255,128,13,10),calls=[];let committed=false;
 const env={...envBase,request:async r=>{
  calls.push(r);const u=new URL(r.url),m=u.searchParams.get('method');
  if(m==='precreate'){const f=new URLSearchParams(r.body);assert.equal(f.get('rtype'),'3');assert.equal(f.get('block_list'),JSON.stringify([hash('md5',content)]));return result({errno:0,uploadid:'upload',block_list:[0],return_type:1});}
  if(m==='upload'){const b=Buffer.from(r.body);assert.ok(b.includes(Buffer.from(content)));assert.ok(b.includes(Buffer.from('\r\nContent-Disposition:')));assert.equal(u.hostname,'d.pcs.baidu.com');return result({md5:hash('md5',content)});}
  if(m==='create'){committed=true;return result({errno:0});}
  if(m==='list')return result({errno:0,list:committed?[{fs_id:'123',server_filename:'ABCDEFGH.zip',size:content.length,isdir:0,server_mtime:1700000000}]:[]});throw Error('unexpected '+r.url);
 }};
 const p=new P.Baidu({baiduFolder:'/apps/test',maxMB:64},{baiduAccess:'access'},env);p.root='/apps/test/zotero';await p.put('ABCDEFGH.zip',content);assert.ok(committed);assert.equal(calls.filter(r=>new URL(r.url).searchParams.get('method')==='create').length,1);
});
test('Quark multipart upload signs OSS requests and checks each ETag',async()=>{
 const content=bytes('abcdef'),calls=[],uploaded=new Map();let fileId=0;
 const env={...envBase,request:async r=>{
  calls.push(r);const u=new URL(r.url),j=typeof r.body==='string'&&r.body.startsWith('{')?JSON.parse(r.body):{};
  if(u.pathname.endsWith('/upload/pre')){uploaded.set(j.file_name,{id:String(++fileId),bytes:content});return result({code:0,data:{task_id:'task',upload_id:'upload',obj_key:'object/key',upload_url:'http://oss-cn-hangzhou.aliyuncs.com',bucket:'bucket',auth_info:'info',callback:{callbackUrl:'https://callback.quark.cn/',callbackBody:'x'}},metadata:{part_size:3}});}
  if(u.pathname.endsWith('/update/hash')){assert.equal(j.md5,hash('md5',content));assert.equal(j.sha1,hash('sha1',content));return result({code:0,data:{finish:false}});}
  if(u.pathname.endsWith('/upload/auth')){assert.match(j.auth_meta,/x-oss-date:/);return result({code:0,data:{auth_key:'signed'}});}
  if(u.hostname.startsWith('bucket.')){assert.equal(r.headers.Cookie,undefined);assert.equal(r.headers.Authorization,'signed');if(r.method==='PUT')return {status:200,bytes:new Uint8Array(),headers:{etag:'"'+hash('md5',r.body)+'"'},cookies:[]};assert.match(r.body,/<CompleteMultipartUpload>/);assert.equal(r.headers['Content-MD5'],hash('md5',bytes(r.body),'base64'));return result({ok:true});}
  if(u.pathname.endsWith('/upload/finish'))return result({code:0});
  if(u.pathname.endsWith('/file/sort'))return result({code:0,data:{list:Array.from(uploaded,([name,v])=>({file_name:name,fid:v.id,file:true,size:v.bytes.length}))},metadata:{_total:uploaded.size}});throw Error('unexpected '+r.url);
 }};
 const p=new P.Quark({quarkFolder:'folder',maxMB:64},{quarkCookie:'__puus=secret'},env);p.root='root';const f=await p.upload('temporary',content);assert.equal(f.size,content.length);assert.equal(calls.filter(r=>r.method==='PUT').length,2);
});
function replacement(fail=false) {
 const p=new P.Quark({}, {}, envBase);p.root='root';const files=new Map([['ABCDEFGH.zip',{id:'old',size:3,dir:false}]]),calls=[];
 p.stat=async name=>files.get(name)||null;p.upload=async(name,b)=>{calls.push('upload');const f={id:'new',size:b.length,dir:false};files.set(name,f);return f;};
 p.rename=async(id,name)=>{calls.push('rename-'+id);if(fail&&id==='new')throw Error('connection lost');for(const[k,v]of files)if(v.id===id){files.delete(k);files.set(name,v);return;}};
 p.removeId=async id=>{calls.push('delete-'+id);for(const[k,v]of files)if(v.id===id)files.delete(k);};return {p,files,calls};
}
test('Quark replacement uploads before renaming or deleting the old file',async()=>{
 const{p,files,calls}=replacement();await p.put('ABCDEFGH.zip',bytes('new'));assert.equal(files.get('ABCDEFGH.zip').id,'new');assert.equal(files.size,1);assert.deepEqual(calls,['upload','rename-old','rename-new','delete-old']);
});
test('Quark replacement restores old filename if final rename fails',async()=>{
 const{p,files,calls}=replacement(true);await assert.rejects(p.put('ABCDEFGH.zip',bytes('new')));assert.equal(files.get('ABCDEFGH.zip').id,'old');assert.equal(files.size,2);assert.ok(!calls.some(x=>x.startsWith('delete-')));
});

test('Quark directory paths support Chinese and spaces but reject root, traversal and invalid separators',()=>{
 const base={provider:'quark',maxMB:64};
 assert.deepEqual(Array.from(C.quarkPathParts('/文献/Project A/Zotero')),['文献','Project A','Zotero']);
 for(const quarkPath of ['','/','folder123','C:/文献','/文献//Zotero','/文献/Zotero/','/文献/../Zotero','/./文献','/文献?x','/文献#x','/文献\\Zotero','/文献\nZotero','/'+Array(33).fill('dir').join('/')]){
  assert.throws(()=>C.validateConfig({...base,quarkPath}),/专用目录/);
 }
 assert.throws(()=>C.validateConfig({...base,quarkFolder:'legacy123',quarkPath:'/'}),/专用目录/);
 assert.doesNotThrow(()=>C.validateConfig({...base,quarkPath:'/文献/Project A/Zotero'}));
});
function quarkFolders(config,listings){
 const calls=[];
 const folder=(name,id)=>({file_name:name,fid:id,file_type:0});
 const env={...envBase,request:async request=>{
  const url=new URL(request.url),id=url.searchParams.get('pdir_fid');
  calls.push([request.method,url.pathname,id,request.body?JSON.parse(request.body):null]);
  if(url.pathname.endsWith('/config'))return result({code:0});
  if(url.pathname.endsWith('/file/sort')&&Object.hasOwn(listings,id)){
   const page=Number(url.searchParams.get('_page'));
   return result({code:0,metadata:{_total:listings[id].length},data:{list:listings[id].slice(100*(page-1),100*page)}});
  }
  if(request.method==='POST'&&url.pathname.endsWith('/file')){
   const body=JSON.parse(request.body);
   listings[body.pdir_fid].push(folder(body.file_name,'sync-store'));
   return result({code:0});
  }
  throw Error('unexpected mock request');
 }};
 return {p:new P.Quark(config,{quarkCookie:'mock-cookie'},env),calls};
}
test('Quark traverses the directory path across pages and creates only its Zotero subfolder',async()=>{
 const other=Array.from({length:100},(_,i)=>({file_name:'Other '+i,fid:'unused-'+i,file_type:0}));
 const {p,calls}=quarkFolders({quarkPath:'/文献/Project A',quarkFolder:'legacy123'}, {
  '0':[...other,{file_name:'文献',fid:'docs-id',file_type:0}],
  'docs-id':[{file_name:'Project A',fid:'project-id',file:false}],
  'project-id':[],
 });
 await p.init();await p.ensureRoot();
 assert.equal(p.identity,'quark:project-id');assert.equal(p.root,'sync-store');
 assert.deepEqual(calls.filter(c=>c[1].endsWith('/file/sort')).map(c=>c[2]),['0','0','docs-id','project-id','project-id']);
 assert.deepEqual(calls.filter(c=>c[0]==='POST').map(c=>[c[3].pdir_fid,c[3].file_name]),[['project-id','zotero']]);
});
test('Quark path resolution stops before writes or legacy fallback if a directory cannot be identified',async()=>{
 const target={file_name:'文献',fid:'docs-id',file_type:0};
 for(const [entries,error] of [[[],/不存在/],[[target,{...target,fid:'other-id'}],/同名/],[[{...target,file_type:1}],/不是可用/],[[{...target,fid:'0'}],/不是可用/],[[{...target,fid:null}],/不是可用/]]){
  const {p,calls}=quarkFolders({quarkPath:'/文献/Zotero',quarkFolder:'legacy123'},{'0':entries,'legacy123':[]});
  await assert.rejects(p.init(),error);
  assert.deepEqual(calls.map(c=>[c[0],c[2]]),[['GET',null],['GET','0']]);
  assert.equal(p.root,null);
 }
});
test('Quark path and legacy ID resolving to the same folder use the same storage and sync binding',async()=>{
 const dirs={'0':[{file_name:'文献',fid:'docs-id',file_type:0}], 'docs-id':[{file_name:'zotero',fid:'existing-store',file_type:0}]};
 for(const config of [{quarkPath:'/文献'},{quarkFolder:'docs-id'}]){
  const {p,calls}=quarkFolders(config,dirs);await p.init();
  assert.equal(p.identity,'quark:docs-id');assert.equal(p.root,'existing-store');
  assert.ok(calls.every(c=>c[0]==='GET'));
 }
});
