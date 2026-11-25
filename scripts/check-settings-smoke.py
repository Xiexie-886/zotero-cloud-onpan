"""Create an isolated, account-free Zotero settings-window test profile."""
from pathlib import Path
import json, zipfile

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'work'/'settings-smoke-022'
(BASE/'report.json').unlink(missing_ok=True)
PROFILE=BASE/'profile'
DATA=BASE/'data'
EXT=PROFILE/'extensions'
EXT.mkdir(parents=True,exist_ok=True)
DATA.mkdir(exist_ok=True)
report=str(BASE/'report.json')
prefs={'extensions.zotero.useDataDir':True,'extensions.zotero.dataDir':str(DATA),
'extensions.zotero.firstRun2':False,'extensions.zotero.firstRunGuidance':False,
'extensions.zotero.httpServer.enabled':False,'extensions.zotero.sync.autoSync':False,
'extensions.update.enabled':False,'extensions.autoDisableScopes':0,'extensions.enabledScopes':15,
'extensions.getAddons.cache.enabled':False,'app.update.enabled':False}
(PROFILE/'user.js').write_text('\n'.join('user_pref('+json.dumps(k)+','+json.dumps(v)+');' for k,v in prefs.items()),encoding='utf-8')
bootstrap=r'''
var testChromeHandle;
function install(){}
function uninstall(){}
async function startup(data){
 const result={steps:[]};
 async function save(){await IOUtils.writeUTF8(REPORT,JSON.stringify(result,null,2));}
 try{
  result.steps.push('bootstrap entered');await save();
  await Zotero.initializationPromise;
  const addonStartup=Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(Components.interfaces.amIAddonManagerStartup);
  testChromeHandle=addonStartup.registerChrome(Services.io.newURI(data.rootURI+'manifest.json'),[['content','cloud-on-demand',data.rootURI]]);
  result.steps.push('registered chrome resources');await save();
  let main=Zotero.getMainWindow();
  for(let i=0;!main&&i<50;i++){await Zotero.Promise.delay(200);main=Zotero.getMainWindow();}
  if(!main)throw Error('No main window');
  const fake={busy:false,status:'Local settings smoke test',core:{CloudError:Error},config:()=>({provider:'quark',quarkPath:'/文献/Zotero',baiduFolder:'/apps/mock',baiduClient:'mock-client',maxMB:64,consent:false}),saveSettings:async()=>{},run:async()=>{},showError:()=>{},launchURL:()=>{},exchange:async()=>{}};
  const win=main.openDialog('chrome://cloud-on-demand/content/settings.xhtml','cloud-on-demand-smoke','chrome,dialog=no,centerscreen,resizable,width=880,height=800',fake);
  for(let i=0;i<80;i++){
   await Zotero.Promise.delay(100);
   if(win.document.readyState==='complete'&&win.document.getElementById('status'))break;
  }
  result.location=win.location.href;
  result.root=win.document.documentElement.localName;
  result.rootNamespace=win.document.documentElement.namespaceURI;
  result.fields=['provider','quark-cookie','quark-folder','save','sync'].map(id=>({id,present:!!win.document.getElementById(id)}));
  result.status=win.document.getElementById('status')?.textContent;
  result.quarkPath=win.document.getElementById('quark-folder')?.value;
  result.hasTestButton=!!win.document.getElementById('test');
  result.width=win.document.getElementById('provider')?.getBoundingClientRect().width;
  if(result.root!=='window'||result.status!==fake.status||!result.width||result.fields.some(x=>!x.present))throw Error('Settings failed to render or initialize');
  const provider=win.document.getElementById('provider-baidu');provider.checked=true;provider.dispatchEvent(new win.Event('change'));
  result.baiduVisible=!win.document.getElementById('baidu-panel').hidden;
  result.quarkHidden=win.document.getElementById('quark-panel').hidden;
  result.baiduDirectoryVisible=!win.document.getElementById('baidu-directory').hidden;
  result.quarkDirectoryHidden=win.document.getElementById('quark-directory').hidden;
  function layout(){
   const main=win.document.getElementById('settings-scroll');
   const footer=win.document.querySelector('.taskbar').getBoundingClientRect();
   const columns=win.getComputedStyle(win.document.querySelector('.setup-grid')).gridTemplateColumns.split(' ').length;
   return {width:win.innerWidth,height:win.innerHeight,footerBottom:footer.bottom,columns,
    contentWidth:main.clientWidth,scrollWidth:main.scrollWidth,
    styled:win.getComputedStyle(main).overflowY==='auto',
    fits:main.clientHeight>0&&main.scrollWidth<=main.clientWidth+1&&Math.abs(footer.bottom-win.innerHeight)<=1};
  }
  result.defaultLayout=layout();
  win.resizeTo(500,700);await Zotero.Promise.delay(350);
  result.narrowLayout=layout();
  result.ok=result.baiduVisible&&result.quarkHidden&&result.baiduDirectoryVisible&&result.quarkDirectoryHidden
   &&result.quarkPath==='/文献/Zotero'&&!result.hasTestButton
   &&result.defaultLayout.styled&&result.defaultLayout.fits&&result.defaultLayout.columns===2
   &&result.narrowLayout.fits&&result.narrowLayout.columns===1;
 }catch(error){result.ok=false;result.error=String(error);result.stack=error.stack;}
 await save();Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);
}
function shutdown(){if(testChromeHandle){testChromeHandle.destruct();testChromeHandle=null;}}
'''.replace('REPORT',json.dumps(report))
manifest=json.loads((ROOT/'manifest.json').read_text('utf-8'))
with zipfile.ZipFile(EXT/'cloud-on-demand@local.zotero.xpi','w',zipfile.ZIP_DEFLATED) as archive:
 archive.writestr('manifest.json',json.dumps(manifest,ensure_ascii=False))
 archive.writestr('bootstrap.js',bootstrap)
 for name in ['settings.xhtml','settings.js','settings.css','qrcode.js']:archive.write(ROOT/name,name)
print(json.dumps({'profile':str(PROFILE),'data':str(DATA),'report':report}))
