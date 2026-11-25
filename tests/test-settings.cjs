const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
function fixture({readyState='loading',missingRuntime=false,wrapped=false,configError=false}={}){
 const elements=new Map(),events=new Map(),calls=[];
 const document={readyState,getElementById:id=>elements.get(id),body:{}};
 document.activeElement=document.body;
 const source=fs.readFileSync(path.join(root,'settings.xhtml'),'utf8');
 for(const match of source.matchAll(/\bid="([^"]+)"/g))elements.set(match[1],{value:'',checked:false,disabled:false,hidden:false,textContent:'',dataset:{},events:new Map(),scrolls:[],contains(el){return el===this||el===elements.get(match[1].replace('-panel','-heading'));},focus(){if(!this.disabled)document.activeElement=this;},scrollIntoView(opts){this.scrolls.push(opts);},removeAttribute(name){delete this[name];},addEventListener(name,fn){this.events.set(name,fn);}});
 class CloudError extends Error{}
 const config={provider:'quark',quarkPath:'/文献/Zotero',baiduFolder:'/apps/test',baiduClient:'own-client',maxMB:64,consent:true};
 const saved={savedAt:'',hasEncryptedCredentials:false,credentials:{}};
 const runtime={busy:false,status:'空闲',loginCancel:null,core:{CloudError},configurationState:()=>saved,config:()=>{if(configError)throw Error('configuration unavailable');return config;},saveSettings:async(c,p)=>{calls.push(['save',c,p]);Object.assign(config,c);if(c.quarkPath)delete config.quarkFolder;saved.savedAt='2026-11-19T00:00:00.000Z';saved.hasEncryptedCredentials=true;if(p.quarkCookie)saved.credentials.quarkCookie=true;},run:async mode=>calls.push(['run',mode]),operationError:(e,stage)=>e instanceof CloudError?e:new CloudError(stage+'失败。'),showError:(e,win,{inline})=>{calls.push(['error',e.message,inline]);runtime.status=runtime.operationError(e,'插件操作').message;runtime.statusTone='error';},launchURL:u=>calls.push(['url',u]),exchange:async code=>calls.push(['exchange',code]),loginBaidu:async(i,onQR)=>{calls.push(['loginBaidu',{client:i.client,hasSecret:!!i.secret}]);onQR('https://openapi.baidu.com/device?display=mobile&code=mock1234','mock1234');saved.credentials.baiduAccess=true;saved.credentials.baiduRefresh=true;},cancelBaiduLogin:()=>calls.push(['cancelBaidu'])};
 const window={arguments:missingRuntime?[]:[wrapped?{wrappedJSObject:runtime}:runtime],addEventListener:(name,fn)=>events.set(name,fn)};
 const ctx=vm.createContext({document,window,URLSearchParams,Promise});vm.runInContext(fs.readFileSync(path.join(root,'qrcode.js'),'utf8'),ctx);vm.runInContext(fs.readFileSync(path.join(root,'settings.js'),'utf8'),ctx);
 return {runtime,config,elements,events,calls,saved,document,select:name=>{for(const key of ['quark','baidu'])elements.get('provider-'+key).checked=key===name;elements.get('provider-'+name).events.get('change')();},init:()=>events.get('DOMContentLoaded')?.(),click:async id=>{elements.get(id).events.get('click')();await new Promise(r=>setImmediate(r));}};
}
test('settings initializes on DOMContentLoaded and switches provider panels',()=>{
 const f=fixture();f.init();assert.equal(f.elements.get('status').textContent,'空闲');assert.equal(f.elements.get('provider-quark').checked,true);assert.equal(f.elements.get('baidu-panel').hidden,true);assert.equal(f.elements.get('quark-panel').hidden,false);
 assert.equal(f.elements.get('baidu-directory').hidden,true);
 f.select('baidu');assert.equal(f.elements.get('baidu-panel').hidden,false);assert.equal(f.elements.get('quark-panel').hidden,true);
 assert.equal(f.elements.get('baidu-directory').hidden,false);assert.equal(f.elements.get('quark-directory').hidden,true);
});
test('settings initializes even when script runs after DOMContentLoaded',()=>{
 const f=fixture({readyState:'complete'});assert.equal(f.elements.get('max-mb').value,64);assert.equal(f.elements.get('consent').checked,true);assert.ok(f.elements.get('save').events.has('click'));
});
test('settings accepts wrapped dialog arguments',()=>{
 const f=fixture({wrapped:true});f.init();assert.equal(f.elements.get('quark-folder').value,'/文献/Zotero');
});
test('missing runtime shows a message and disables actions',()=>{
 const f=fixture({missingRuntime:true});f.init();assert.match(f.elements.get('status').textContent,/工具菜单/);for(const id of ['save','sync','baidu-exchange','baidu-auth','baidu-login'])assert.equal(f.elements.get(id).disabled,true);
});
test('configuration initialization error appears in the window',()=>{
 const f=fixture({configError:true});f.init();assert.equal(f.elements.get('task-state').dataset.tone,'error');assert.match(f.elements.get('status').textContent,/加载失败/);assert.doesNotMatch(f.elements.get('status').textContent,/configuration unavailable/);assert.equal(f.elements.get('save').disabled,true);
});
test('saving preserves entered credentials and sync waits for save',async()=>{
 const f=fixture();f.init();f.elements.get('quark-cookie').value='fake-test-cookie';await f.click('sync');
 assert.deepEqual(f.calls.map(c=>c[0]),['save','run']);assert.equal(f.calls[0][2].quarkCookie,'fake-test-cookie');assert.equal(f.calls[1][1],'sync');assert.equal(f.elements.get('quark-cookie').value,'fake-test-cookie');
});
test('official authorization page opens through runtime without relying on opener',async()=>{
 const f=fixture();f.init();await f.click('baidu-auth');assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'url');const u=new URL(f.calls[0][1]);assert.equal(u.hostname,'openapi.baidu.com');assert.equal(u.searchParams.get('client_id'),'own-client');
});
test('busy state disables actions and restores them after task finishes',()=>{
 const f=fixture();f.init();f.runtime.busy=true;f.events.get('cloud-state')();assert.equal(f.elements.get('sync').disabled,true);f.runtime.busy=false;f.events.get('cloud-state')();assert.equal(f.elements.get('sync').disabled,false);
});
test('clicking away from the cookie keeps the unsaved input and never saves automatically',async()=>{
 const f=fixture();f.init();const cookie=f.elements.get('quark-cookie');cookie.value='mock-cookie';cookie.events.get('input')();cookie.events.get('blur')();await Promise.resolve();
 assert.equal(cookie.value,'mock-cookie');assert.equal(f.calls.length,0);assert.match(f.elements.get('config-state').textContent,/未保存/);assert.match(f.elements.get('quark-cookie-state').textContent,/尚未保存/);
});
test('blur restores an input draft if the window control unexpectedly drops its value',async()=>{
 const f=fixture();f.init();const cookie=f.elements.get('quark-cookie');cookie.value='mock-cookie';cookie.events.get('input')();cookie.value='';cookie.events.get('blur')();await Promise.resolve();assert.equal(cookie.value,'mock-cookie');
});
test('an intentional deletion stays empty after blur',async()=>{
 const f=fixture();f.init();const cookie=f.elements.get('quark-cookie');cookie.value='mock-cookie';cookie.events.get('input')();cookie.value='';cookie.events.get('input')();cookie.events.get('blur')();await Promise.resolve();assert.equal(cookie.value,'');
});
test('runtime status updates do not overwrite cookie drafts',()=>{
 const f=fixture();f.init();const cookie=f.elements.get('quark-cookie');cookie.value='mock-cookie';cookie.events.get('input')();f.runtime.status='另一个状态';f.events.get('cloud-state')();assert.equal(cookie.value,'mock-cookie');assert.match(f.elements.get('config-state').textContent,/未保存/);
});
test('top save button saves locally without connecting and confirms encrypted cookie state',async()=>{
 const f=fixture();f.init();const cookie=f.elements.get('quark-cookie');cookie.value='mock-cookie';cookie.events.get('input')();await f.click('save-top');
 assert.deepEqual(f.calls.map(c=>c[0]),['save']);assert.equal(cookie.value,'mock-cookie');assert.match(f.elements.get('config-state').textContent,/已保存/);assert.match(f.elements.get('quark-cookie-state').textContent,/已加密保存/);
});
test('a failed save preserves input and the unsaved marker',async()=>{
 const f=fixture();f.init();const cookie=f.elements.get('quark-cookie');cookie.value='mock-cookie';cookie.events.get('input')();f.runtime.saveSettings=async()=>{throw Error('storage unavailable');};await f.click('save-top');
 assert.equal(cookie.value,'mock-cookie');assert.match(f.elements.get('config-state').textContent,/未保存/);assert.equal(f.calls[0][0],'error');assert.equal(f.calls[0][2],true);assert.equal(f.elements.get('task-state').dataset.tone,'error');assert.equal(f.elements.get('save-top').disabled,false);
});
test('reopened settings indicates stored cookie without decrypting or filling it',()=>{
 const f=fixture();f.saved.savedAt='2026-11-19T00:00:00.000Z';f.saved.hasEncryptedCredentials=true;f.saved.credentials.quarkCookie=true;f.init();
 assert.equal(f.elements.get('quark-cookie').value,'');assert.match(f.elements.get('quark-cookie-state').textContent,/已保存 Cookie/);assert.match(f.elements.get('config-state').textContent,/已保存/);
});
test('repeated save clicks while persistence is pending do not race',async()=>{
 const f=fixture();f.init();let resolve,calls=0;f.runtime.saveSettings=()=>{calls++;return new Promise(r=>{resolve=r;});};
 const top=f.elements.get('save-top').events.get('click'),bottom=f.elements.get('save').events.get('click');
 const pending=top();await Promise.resolve();bottom();assert.equal(calls,1);assert.equal(f.elements.get('save-top').disabled,true);resolve();await pending;assert.equal(f.elements.get('save-top').disabled,false);
});
test('closing with unsaved data requests confirmation and clears only window drafts on unload',()=>{
 const f=fixture();f.init();const cookie=f.elements.get('quark-cookie');cookie.value='mock-cookie';cookie.events.get('input')();let warned=false;f.events.get('beforeunload')({preventDefault(){warned=true;}});assert.equal(warned,true);f.events.get('unload')();assert.equal(cookie.value,'');assert.equal(f.calls.length,0);
});
test('QR login works before folder configuration and clears a stale manual draft only on success',async()=>{
 const f=fixture();f.init();f.elements.get('quark-folder').value='';const cookie=f.elements.get('quark-cookie');cookie.value='old-draft';cookie.events.get('input')();
 f.runtime.loginQuark=async onQR=>{onQR('https://su.quark.cn/4_eMHBJ?token=MOCK');assert.equal(f.elements.get('quark-qr-panel').hidden,false);assert.match(f.elements.get('quark-qr').src,/^data:image\/gif;base64,/);f.saved.credentials.quarkCookie=true;};
 await f.click('quark-login');assert.equal(f.calls.length,0);assert.equal(cookie.value,'');assert.equal(f.elements.get('quark-qr-panel').hidden,true);assert.equal(f.elements.get('quark-qr').src,undefined);
 cookie.events.get('blur')();await Promise.resolve();assert.equal(cookie.value,'');
});
test('QR failure removes image but preserves existing manual input',async()=>{
 const f=fixture();f.init();f.elements.get('quark-cookie').value='old-draft';f.runtime.loginQuark=async onQR=>{onQR('https://su.quark.cn/4_eMHBJ?token=MOCK');throw Error('expired');};
 await f.click('quark-login');assert.equal(f.elements.get('quark-cookie').value,'old-draft');assert.equal(f.elements.get('quark-qr-panel').hidden,true);assert.equal(f.elements.get('quark-qr').src,undefined);assert.equal(f.calls[0][0],'error');
});
test('QR cancellation and window close cancel waiting without starting sync',()=>{
 const f=fixture();f.init();let cancelled=0;f.runtime.cancelQuarkLogin=()=>{cancelled++;};f.runtime.loginCancel={};f.runtime.busy=true;f.events.get('cloud-state')();assert.equal(f.elements.get('quark-login-cancel').disabled,false);assert.equal(f.elements.get('sync').disabled,true);assert.equal(f.elements.get('quark-cookie').disabled,true);
 f.elements.get('quark-login-cancel').events.get('click')();f.events.get('unload')();assert.equal(cancelled,2);assert.equal(f.calls.length,0);
});
test('Baidu QR shows a local QR and user code then clears secret draft and artifacts on success',async()=>{
 const f=fixture();f.init();f.select('baidu');f.elements.get('baidu-client').value='OWN_CLIENT';f.elements.get('baidu-secret').value='OWN_SECRET';f.elements.get('baidu-secret').events.get('input')();
 let shownImage,shownCode,shownPanel;const login=f.runtime.loginBaidu;
 f.runtime.loginBaidu=(input,onQR)=>login(input,(url,user)=>{onQR(url,user);shownImage=f.elements.get('baidu-qr').src;shownCode=f.elements.get('baidu-user-code').textContent;shownPanel=f.elements.get('baidu-qr-panel').hidden;});
 await f.click('baidu-login');const image=f.elements.get('baidu-qr');assert.equal(f.calls[0][0],'loginBaidu');assert.deepEqual(f.calls[0][1],{client:'OWN_CLIENT',hasSecret:true});assert.match(shownImage,/^data:image\/gif;base64,/);assert.equal(shownCode,'mock1234');assert.equal(shownPanel,false);assert.equal(image.src,undefined);assert.equal(f.elements.get('baidu-qr-panel').hidden,true);assert.equal(f.elements.get('baidu-user-code').textContent,'');assert.equal(f.elements.get('baidu-secret').value,'');assert.match(f.elements.get('baidu-login-state').textContent,/已保存百度授权/);
});
test('Baidu QR failure removes visual code but retains app credentials',async()=>{
 const f=fixture();f.init();for(const [id,value] of [['baidu-client','CLIENT'],['baidu-secret','SECRET'],['baidu-access','ACCESS'],['baidu-refresh','REFRESH']])f.elements.get(id).value=value;
 f.runtime.loginBaidu=async(_,onQR)=>{onQR('https://openapi.baidu.com/device?code=mock','USER');throw Error('expired');};await f.click('baidu-login');
 for(const [id,value] of [['baidu-client','CLIENT'],['baidu-secret','SECRET'],['baidu-access','ACCESS'],['baidu-refresh','REFRESH']])assert.equal(f.elements.get(id).value,value);
 assert.equal(f.elements.get('baidu-qr-panel').hidden,true);assert.equal(f.elements.get('baidu-qr').src,undefined);assert.equal(f.calls.at(-1)[0],'error');
});
test('Baidu cancel control is provider-specific and disables credentials while login is active',()=>{
 const f=fixture();f.init();f.runtime.loginCancel={provider:'baidu'};f.runtime.busy=true;f.events.get('cloud-state')();
 assert.equal(f.elements.get('baidu-login-cancel').disabled,false);assert.equal(f.elements.get('quark-login-cancel').disabled,true);assert.equal(f.elements.get('baidu-client').disabled,true);
 f.elements.get('baidu-login-cancel').events.get('click')();assert.equal(f.calls[0][0],'cancelBaidu');
});

test('switching back preserves directory drafts and writes the selected provider on explicit save',async()=>{
 const f=fixture();f.config.provider='baidu';f.init();
 assert.equal(f.elements.get('provider-baidu').checked,true);
 assert.equal(f.elements.get('baidu-directory').hidden,false);
 f.elements.get('baidu-folder').value='/apps/test/edited';
 f.select('quark');f.elements.get('quark-folder').value='/新目录/夸克';f.select('baidu');
 assert.equal(f.elements.get('baidu-folder').value,'/apps/test/edited');
 assert.equal(f.calls.length,0);
 await f.click('save');
 assert.equal(f.calls[0][1].provider,'baidu');
 assert.equal(f.calls[0][1].quarkPath,'/新目录/夸克');
 assert.equal(f.elements.get('config-state').dataset.state,'saved');
});
test('settings has no test button and sync checks confirmation before saving',async()=>{
 const f=fixture();f.config.consent=false;f.init();
 assert.equal(f.elements.has('test'),false);
 await f.click('sync');
 assert.equal(f.document.activeElement,f.elements.get('consent'));
 assert.match(f.elements.get('status').textContent,/实验版确认/);
 assert.deepEqual(f.calls.map(c=>c[0]),['error']);
});
test('legacy Quark ID is never displayed and replacing it accepts a directory path',async()=>{
 const f=fixture();f.config.quarkPath='';f.config.quarkFolder='legacy123';f.init();
 assert.equal(f.elements.get('quark-folder').value,'');
 assert.equal(f.elements.get('quark-legacy').hidden,false);
 await f.click('save');
 assert.equal(f.calls[0][1].quarkPath,'');assert.equal(Object.hasOwn(f.calls[0][1],'quarkFolder'),false);
 f.elements.get('quark-folder').value=' /文献/Zotero ';
 await f.click('save');
 assert.equal(f.calls[1][1].quarkPath,'/文献/Zotero');
 assert.equal(f.elements.get('quark-legacy').hidden,true);
});
test('task bar retains actionable errors and shows busy, success and cancellation updates',()=>{
 const f=fixture();f.init();
 for(const [busy,tone,label] of [[true,'info','正在处理网盘任务'],[false,'success','操作完成'],[false,'warning','任务已取消'],[false,'error','操作未完成']]){
  f.runtime.busy=busy;f.runtime.statusTone=tone;f.runtime.status='任务说明';f.events.get('cloud-state')();
  assert.equal(f.elements.get('task-state').dataset.tone,busy?'busy':tone);
  assert.equal(f.elements.get('task-title').textContent,label);
  assert.equal(f.elements.get('status').textContent,'任务说明');
 }
});
test('QR reveal scrolls the panel into view and restores focus after dismissal',async()=>{
 const f=fixture();f.init();
 f.runtime.loginQuark=async onQR=>{
  onQR('https://su.quark.cn/4_eMHBJ?token=MOCK');
  assert.equal(f.document.activeElement,f.elements.get('quark-qr-heading'));
  assert.equal(f.elements.get('quark-qr-panel').scrolls[0].block,'nearest');
 };
 await f.click('quark-login');
 assert.equal(f.document.activeElement,f.elements.get('quark-login'));
});
test('stored authorization badges reflect presence only, never disclose or infer a live session',()=>{
 const f=fixture();f.saved.hasEncryptedCredentials=true;f.init();
 assert.equal(f.elements.get('quark-auth-state').dataset.state,'unknown');
 f.saved.credentials={quarkCookie:true,baiduAccess:true,baiduRefresh:true};f.events.get('cloud-state')();
 for(const id of ['quark-auth-state','baidu-login-state'])assert.equal(f.elements.get(id).dataset.state,'saved');
 for(const id of ['quark-cookie','baidu-access','baidu-refresh'])assert.equal(f.elements.get(id).value,'');
});
