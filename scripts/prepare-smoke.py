from pathlib import Path
import json, shutil
from build import ROOT as root, FILES
base=root/'work'/'zotero-smoke'
profile=base/'profile'; data=base/'data'
ext=profile/'extensions'/'cloud-on-demand@local.zotero'
ext.mkdir(parents=True,exist_ok=True);data.mkdir(parents=True,exist_ok=True)
for name in FILES:
 shutil.copy2(root/name,ext/name)
prefs={'extensions.zotero.useDataDir':True,'extensions.zotero.dataDir':str(data),'extensions.zotero.firstRun2':False,'extensions.zotero.firstRunGuidance':False,'extensions.zotero.httpServer.enabled':False,'extensions.zotero.sync.autoSync':False,'extensions.update.enabled':False,'extensions.autoDisableScopes':0,'extensions.enabledScopes':15,'extensions.getAddons.cache.enabled':False,'app.update.enabled':False,'browser.shell.checkDefaultBrowser':False,'datareporting.healthreport.uploadEnabled':False,'xpinstall.signatures.required':False,'browser.startup.homepage':'about:blank'}
(profile/'user.js').write_text('\n'.join('user_pref('+json.dumps(k)+', '+json.dumps(v)+');' for k,v in prefs.items()),encoding='utf-8')
bootstrap=(ext/'bootstrap.js').read_text(encoding='utf-8')
extra=r'''
var originalStartup=startup;
startup=async function(data){
 const report={steps:[]};
 const io=globalThis.IOUtils || ChromeUtils.importESModule('resource://gre/modules/IOUtils.sys.mjs').IOUtils;
 const out=REPORT;
 async function save(){await io.writeUTF8(out,JSON.stringify(report,null,2));}
 try{
  report.steps.push('bootstrap entered');await save();
  await originalStartup(data);report.steps.push('plugin startup passed');await save();
  const rt=CloudOnDemand;report.version=Zotero.version;report.initialActive=rt.active;
  const files=new Map();
  const provider={identity:'smoke',init:async()=>{},ensureRoot:async()=>{},list:async()=>Array.from(files,([name,b])=>({name,size:b.length,dir:false,modified:Date.now()})),stat:async name=>files.has(name)?{name,size:files.get(name).length,dir:false}:null,put:async(name,b)=>files.set(name,b),get:async name=>files.get(name),remove:async name=>files.delete(name),dispose:async()=>{}};
  rt.providers.create=()=>provider;
  const s=await rt.startSession({provider:'quark',quarkFolder:'smoke-folder',maxMB:64});
  report.port=s.server.identity.primaryPort;report.steps.push('temporary server started');await save();
  const headers={Authorization:s.auth},body=Uint8Array.of(0,255,128,10,13,77),path=s.base+'zotero/ABCDEFGH.zip';
  await Zotero.HTTP.request('PUT',path,{headers,body,successCodes:[204]});
  const r=await Zotero.HTTP.request('GET',path,{headers,responseType:'arraybuffer',successCodes:[200]});
  const got=new Uint8Array(r.response);
  if(got.length!==body.length||got.some((x,i)=>x!==body[i]))throw Error('binary roundtrip mismatch');
  report.steps.push('real HTTP binary roundtrip passed');await save();
  await rt.testSession(s);report.steps.push('native WebDAV verifier passed');await save();
  await rt.stopSession(s);report.closed=rt.active===null;report.steps.push('temporary server closed');await save();
  rt.openSettings();await Zotero.Promise.delay(1200);
  const doc=rt.settingsWindow.document;
  report.settings={title:doc.title,ready:!!doc.getElementById('provider'),status:doc.getElementById('status')?.textContent};
  if(!report.settings.ready||report.settings.status==='正在读取设置…')throw Error('settings UI failed to initialize');
  report.steps.push('settings window initialized');
  await rt.shutdown();report.steps.push('shutdown passed');report.ok=true;
 }catch(e){report.ok=false;report.error=String(e);report.stack=e.stack;}
 await save();Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
};
'''.replace('REPORT',json.dumps(str(base/'report.json')))
(ext/'bootstrap.js').write_text(bootstrap+extra,encoding='utf-8')
print(json.dumps({'profile':str(profile),'data':str(data),'extension':str(ext)}))
