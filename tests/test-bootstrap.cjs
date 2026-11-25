const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
const root=path.resolve(__dirname,'..');
function fixture({menuReady=true,failModule=false}={}){
 const elements=new Map(),listeners=new Map(),calls=[],logs=[];
 function element(tag){return {tag,children:[],id:'',attributes:{},setAttribute(k,v){this.attributes[k]=v;},addEventListener(k,fn){this[k]=fn;},append(child){this.children.push(child);if(child.id)elements.set(child.id,child);},remove(){elements.delete(this.id);}};}
 const popup=element('menupopup');elements.set('menu_ToolsPopup',popup);
 const win={closed:false,document:{readyState:'complete',getElementById:id=>menuReady?elements.get(id)||null:null,createXULElement:element},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
 const values=new Map(),branch={getStringPref:(k,f)=>values.get(k)||f,setStringPref:(k,v)=>values.set(k,v)};
 const native={sync:async()=>{},stop:()=>{},downloadFile:async()=>{},addError:()=>{},getStorageController:()=>{},syncInProgress:false};
 const storage={getModeForLibrary:()=> 'zfs',getEnabledForLibrary:()=>true,downloadOnSync:()=>true,downloadAsNeeded:()=>false};
 const Zotero={initializationPromise:Promise.resolve(),getMainWindows:()=>[win],getMainWindow:()=>win,Sync:{Runner:{...native},Storage:{Mode:{WebDAV:function(){}},Local:storage}},debug:s=>logs.push(s),logError:e=>logs.push(String(e))};
 const registration={calls:[],destructed:0};
 const addonStartup={registerChrome:(uri,entries)=>{registration.calls.push({uri,entries});return {destruct:()=>registration.destructed++};}};
 const Components={classes:{'@mozilla.org/addons/addon-manager-startup;1':{getService:()=>addonStartup}},interfaces:{amIAddonManagerStartup:{}}};
 const context=vm.createContext({URL,URLSearchParams,TextEncoder,TextDecoder,XMLHttpRequest:function(){},Uint8Array,ArrayBuffer,Zotero,ChromeUtils:{},Components,Services:{prefs:{getBranch:()=>branch},io:{newURI:uri=>uri}}});
 // A normal Node VM injects console. Zotero's plugin sandbox only requests the
 // web globals enumerated by its plugin loader, so model an absent console.
 vm.runInContext('delete globalThis.console;',context);
 let privilegedWindowReads=0;
 Object.defineProperty(context.Services,'appShell',{get(){privilegedWindowReads++;throw Error('Bootstrap must not depend on hiddenDOMWindow globals');}});
 context.Services.scriptloader={loadSubScript(uri,target,charset){
  const name=uri.slice(uri.lastIndexOf('/')+1);calls.push({name,target,charset});
  if(failModule&&name==='providers.js')throw Error('module fixture failed');
  const code=fs.readFileSync(path.join(root,name),'utf8');
  if(target===context||target===vm.runInContext('globalThis',context))vm.runInContext(code,context,{filename:name});
  else vm.runInContext(code,vm.createContext(target),{filename:name});
 }};
 vm.runInContext(fs.readFileSync(path.join(root,'bootstrap.js'),'utf8'),context,{filename:'bootstrap.js'});
 return {context,win,popup,elements,listeners,calls,logs,native,Zotero,registration,makeMenuReady:()=>{menuReady=true;},getPrivilegedWindowReads:()=>privilegedWindowReads};
}
test('bootstrap module loads in modeled Zotero plugin scope without hidden window or console',async()=>{
 const f=fixture();await f.context.startup({id:'cloud-on-demand@local.zotero',version:'0.1.2',rootURI:'file:///fixture/'});
 assert.equal(f.getPrivilegedWindowReads(),0);assert.deepEqual(f.calls.map(x=>x.name),['core.js','providers.js','runtime.js']);
 assert.ok(f.calls.every(x=>x.charset==='UTF-8'));
 assert.equal(f.elements.get('cloud-on-demand-menu').attributes.label,'网盘按需同步');
 assert.equal(f.popup.children.length,1);assert.ok(f.context.CloudOnDemand);
 await f.context.shutdown();assert.equal(f.elements.has('cloud-on-demand-menu'),false);assert.equal(f.Zotero.Sync.Runner.sync,f.native.sync);
});
test('main-window callback adds exactly one menu and can remove it',async()=>{
 const f=fixture();await f.context.startup({id:'cloud-on-demand@local.zotero',version:'0.1.2',rootURI:'file:///fixture/'});
 f.context.onMainWindowLoad({window:f.win});f.context.onMainWindowLoad({window:f.win});assert.equal(f.popup.children.length,1);
 const menu=f.elements.get('cloud-on-demand-menu');assert.deepEqual(Array.from(menu.children[0].children,x=>x.attributes.label),['开始附件同步','同步设置…']);
 f.context.onMainWindowUnload({window:f.win});assert.equal(f.elements.has('cloud-on-demand-menu'),false);await f.context.shutdown();
});
test('bootstrap module failure is surfaced and partial runtime is cleared',async()=>{
 const f=fixture({failModule:true});await assert.rejects(f.context.startup({id:'cloud-on-demand@local.zotero',version:'0.1.2',rootURI:'file:///fixture/'}));
 assert.ok(f.logs.some(s=>s.includes('Cloud On Demand')));assert.equal(f.context.CloudOnDemand,undefined);assert.equal(f.elements.has('cloud-on-demand-menu'),false);assert.equal(f.registration.destructed,1);
});
test('chrome resources register before the window opens and are released at shutdown',async()=>{
 const f=fixture();await f.context.startup({id:'cloud-on-demand@local.zotero',version:'0.1.3',rootURI:'jar:file:///fixture.xpi!/'});
 assert.equal(f.registration.calls.length,1);assert.equal(f.registration.calls[0].uri,'jar:file:///fixture.xpi!/manifest.json');
 assert.deepEqual(Array.from(f.registration.calls[0].entries[0]),['content','cloud-on-demand','jar:file:///fixture.xpi!/']);
 let request;f.win.openDialog=(...args)=>{request=args;return {closed:false,close(){this.closed=true;}};};
 f.context.CloudOnDemand.openSettings(f.win);
 assert.equal(request[0],'chrome://cloud-on-demand/content/settings.xhtml');assert.ok(request[2].includes('dialog=no'));assert.equal(request[3],f.context.CloudOnDemand);
 await f.context.shutdown();assert.equal(f.registration.destructed,1);
});
test('a window whose menu is not ready gets its menu on a later load event',async()=>{
 const f=fixture({menuReady:false});await f.context.startup({id:'cloud-on-demand@local.zotero',version:'0.1.2',rootURI:'file:///fixture/'});
 assert.equal(f.popup.children.length,0);assert.equal(f.listeners.size,3);
 f.makeMenuReady();f.listeners.get('load')();assert.equal(f.popup.children.length,1);assert.equal(f.listeners.size,0);
 await f.context.shutdown();
});
test('shutdown removes deferred menu listeners before the window is ready',async()=>{
 const f=fixture({menuReady:false});await f.context.startup({id:'cloud-on-demand@local.zotero',version:'0.1.2',rootURI:'file:///fixture/'});
 assert.equal(f.listeners.size,3);await f.context.shutdown();assert.equal(f.listeners.size,0);
});
