/* SPDX-License-Identifier: AGPL-3.0-or-later */
var CloudRuntime = class {
  constructor(data, core, providers) {
    this.data=data;this.core=core;this.providers=providers;this.busy=false;this.active=null;this.settingsWindow=null;this.status='空闲；没有临时 WebDAV 服务。';this.statusTone='info';
    this.branch=Services.prefs.getBranch('extensions.zotero.cloudOnDemand.');
    this.defaults={provider:'quark',quarkPath:'',quarkFolder:'',baiduFolder:'',baiduClient:'',maxMB:64,consent:false};
    this.native={};this.running=null;this.pendingWindows=new Map();this.loginCancel=null;
  }
  config() { try{return {...this.defaults, ...JSON.parse(this.branch.getStringPref('config','{}'))};}catch(_){return {...this.defaults};} }
  async secrets() {
    const value=this.branch.getStringPref('credentials','');if(!value)return {};
    if(!Zotero.OSKeyStore?.isEncrypted(value))throw new this.core.CloudError('凭据不是受支持的加密格式，请重新保存。');
    return JSON.parse(await Zotero.OSKeyStore.decrypt(value));
  }
  async saveSecrets(value) {
    if(!Zotero.OSKeyStore?.encrypt)throw new this.core.CloudError('当前 Zotero 不支持操作系统凭据加密。');
    const encrypted=await Zotero.OSKeyStore.encrypt(JSON.stringify(value));
    this.branch.setStringPref('credentials',encrypted);
    const presence={};for(const key of ['quarkCookie','baiduSecret','baiduAccess','baiduRefresh'])presence[key]=!!value[key];
    this.branch.setStringPref('credentialPresence',JSON.stringify(presence));
  }
  configurationState() {
    let credentials={};try{credentials=JSON.parse(this.branch.getStringPref('credentialPresence','{}'));}catch(_){}
    return {savedAt:this.branch.getStringPref('savedAt',''),hasEncryptedCredentials:!!this.branch.getStringPref('credentials',''),credentials};
  }
  async saveSettings(config, patch) {
    return this.step('保存本机配置',()=>this._saveSettings(config,patch));
  }
  async _saveSettings(config, patch) {
    if(this.busy)throw new this.core.CloudError('同步过程中不能更改设置。');
    const {quarkPath,quarkFolder}=this.config();
    const next={...this.defaults,quarkPath,quarkFolder,...config};
    next.maxMB=Number(next.maxMB);next.consent=!!next.consent;
    // An explicit path replaces the legacy ID; never fall back if lookup fails.
    if(next.quarkPath)delete next.quarkFolder;
    this.core.validateConfig(next);
    const secrets=await this.secrets();
    for(const key of ['quarkCookie','baiduSecret','baiduAccess','baiduRefresh']) {
      if(patch[key]) {
        if(/[\r\n]/.test(patch[key]))throw new this.core.CloudError('凭据中不能包含换行符。');
        secrets[key]=patch[key].trim();
      }
    }
    await this.saveSecrets(secrets);this.branch.setStringPref('config',JSON.stringify(next));
    this.branch.setStringPref('savedAt',new Date().toISOString());
    Services.prefs.savePrefFile(null);
    this.setStatus('配置已保存到本机；凭据已加密保存。未连接网盘。','success');
  }
  setStatus(value,tone='info') {
    this.status=value;this.statusTone=tone;
    if(this.settingsWindow&&!this.settingsWindow.closed) {
      this.settingsWindow.dispatchEvent(new this.settingsWindow.Event('cloud-state'));
    }
  }
  random() {return Services.uuid.generateUUID().toString().replace(/[{}-]/g,'');}
  bytes64(bytes) {
    let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(s);
  }
  hash(algorithm,bytes,encoding='hex') {
    const h=Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
    h.init(algorithm==='md5'?h.MD5:h.SHA1);h.update(bytes,bytes.length);
    const binary=h.finish(false);
    if(encoding==='base64')return btoa(binary);
    return Array.from(binary,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  }
  env() {return {request:this.request.bind(this),saveSecrets:this.saveSecrets.bind(this),delay:ms=>Zotero.Promise.delay(ms),hash:this.hash.bind(this),base64:this.bytes64.bind(this),random:this.random.bind(this)};}
  async request(options) {
    return this.step(this.core.requestStage(options),()=>this._request(options));
  }
  async _request(options) {
    const E=this.core.CloudError;
    if(options.cancel?.cancelled)throw new E('扫码登录已取消。');
    this.core.validateURL(options.url,options.provider,options.kind);
    const stage=this.core.requestStage(options);
    this.setStatus('正在执行：'+stage+'…');
    const max=options.maxBytes||2*1048576;
    return new Promise((resolve,reject)=>{
      // Deliberately bypass Zotero.HTTP debug logging: OAuth URLs contain secrets.
      const xhr=new XMLHttpRequest({mozAnon:true});
      let settled=false,redirects=0;
      const release=()=>{if(options.cancel)options.cancel.abort=null;};
      const fail=message=>{if(settled)return;settled=true;release();reject(message instanceof E?message:new E(stage+'：'+message));};
      xhr.mozBackgroundRequest=true;xhr.open(options.method||'GET',options.url,true);
      xhr.responseType='arraybuffer';xhr.timeout=options.timeout||120000;
      xhr.channel.loadFlags|=Components.interfaces.nsIRequest.LOAD_BYPASS_CACHE;
      const thisRuntime=this;
      const callbacks={
        QueryInterface:ChromeUtils.generateQI(['nsIInterfaceRequestor']),
        getInterface(iid) {
          if(iid.equals(Components.interfaces.nsIChannelEventSink))return {
            QueryInterface:ChromeUtils.generateQI(['nsIChannelEventSink']),
            asyncOnChannelRedirect:(oldChannel,newChannel,flags,callback)=>{
              try {
                if(++redirects>(options.redirects||0))throw new Error('redirect');
                const u=thisRuntime.core.validateURL(newChannel.URI.spec,options.provider,options.kind);
                if(options.provider==='baidu'&&!(u.hostname==='baidu.com'||u.hostname.endsWith('.baidu.com')||u.hostname==='baidupcs.com'||u.hostname.endsWith('.baidupcs.com'))) {
                  for(const key of ['access_token','refresh_token','client_secret','code'])if(u.searchParams.has(key))throw new Error('credential redirect');
                }
                const http=newChannel.QueryInterface(Components.interfaces.nsIHttpChannel);
                http.setRequestHeader('Authorization','',false);
                if(!(options.provider==='quark'&&(u.hostname==='quark.cn'||u.hostname.endsWith('.quark.cn'))))http.setRequestHeader('Cookie','',false);
                callback.onRedirectVerifyCallback(Components.results.NS_OK);
              }catch(_){callback.onRedirectVerifyCallback(Components.results.NS_ERROR_ABORT);fail('网盘重定向目标未通过检查。');}
            }
          };
          throw Components.Exception('No interface',Components.results.NS_ERROR_NO_INTERFACE);
        }
      };
      xhr.channel.notificationCallbacks=callbacks;
      for(const [key,value]of Object.entries(options.headers||{})){
        if(/^(cookie|user-agent|referer)$/i.test(key)){
          // XHR can silently ignore forbidden request headers. Set these on
          // the privileged HTTP channel and verify Cookie was actually set.
          try{
            const http=xhr.channel.QueryInterface(Components.interfaces.nsIHttpChannel);
            http.setRequestHeader(key,String(value),false);
            if(/^cookie$/i.test(key)&&http.getRequestHeader(key)!==String(value))throw new Error('Cookie not attached');
          }catch(_){fail('无法附加网盘认证请求头；请求尚未发送。');return;}
        }else xhr.setRequestHeader(key,String(value));
      }
      xhr.onprogress=e=>{if(e.loaded>max){fail('网盘响应超过允许大小。');xhr.abort();}};
      xhr.onerror=()=>fail('无法连接网盘，请检查网络、Cookie 或授权状态。');
      xhr.ontimeout=()=>fail('网盘请求超时；没有确认本次操作完成。');
      xhr.onabort=()=>fail('网盘请求已中断。');
      xhr.onload=()=>{
        if(settled)return;
        const bytes=new Uint8Array(xhr.response||new ArrayBuffer(0));
        if(bytes.length>max){fail('网盘响应超过允许大小。');return;}
        // OAuth pending/denied device authorization may use HTTP 400. Only
        // permit a JSON body for these two exact first-party OAuth endpoints.
        const oauthURL=new URL(options.url);
        const oauth400=xhr.status===400&&options.provider==='baidu'&&options.kind==='login'&&oauthURL.hostname==='openapi.baidu.com'&&['/oauth/2.0/device/code','/oauth/2.0/token'].includes(oauthURL.pathname);
        if((xhr.status<200||xhr.status>=300)&&!oauth400){fail(this.core.httpFailure(options,xhr.status,bytes));return;}
        const headers={},cookies=[];
        for(const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
          const i=line.indexOf(':');if(i<0)continue;
          const key=line.slice(0,i).toLowerCase(),value=line.slice(i+1).trim();
          if(key==='set-cookie')cookies.push(value);else headers[key]=value;
        }
        try {
          const raw=xhr.channel.QueryInterface(Components.interfaces.nsIHttpChannel).getResponseHeader('Set-Cookie');
          for(const cookie of raw.split(/\r?\n/))if(!cookies.includes(cookie))cookies.push(cookie);
        }catch(_){}
        settled=true;release();resolve({status:xhr.status,bytes,headers,cookies});
      };
      if(options.cancel){options.cancel.abort=()=>{fail(new E('扫码登录已取消。'));xhr.abort();};if(options.cancel.cancelled){options.cancel.abort();return;}}
      try{xhr.send(options.body??null);}catch(_){fail('发送网盘请求失败。');}
    });
  }
  async startup() {
    if(!Zotero.Sync.Runner?.getStorageController||!Zotero.Sync.Storage.Mode.WebDAV)throw new Error('Unsupported Zotero sync API');
    const r=Zotero.Sync.Runner,l=Zotero.Sync.Storage.Local,self=this;
    this.native.sync=r.sync;this.native.download=r.downloadFile;this.native.stop=r.stop;
    this.native.controller=r.getStorageController;this.native.mode=l.getModeForLibrary;this.native.addError=r.addError;
    this.native.enabled=l.getEnabledForLibrary;this.native.onSync=l.downloadOnSync;this.native.asNeeded=l.downloadAsNeeded;
    this.wrappers={
      sync:function(options={}) {
        if(self.busy)return Promise.resolve(false);
        if(!self.config().consent)return self.native.sync.call(this,options);
        // Regular sync remains available for metadata; cloud attachments use our own button.
        const user=Zotero.Libraries.userLibraryID;
        const files=options.fileLibraries||options.libraries||Zotero.Libraries.getAll().map(x=>x.libraryID);
        return self.native.sync.call(this,{...options,fileLibraries:Array.from(files).filter(id=>id!==user)});
      },
      download:async function(item,...args) {
        if(self.config().consent&&item.libraryID===Zotero.Libraries.userLibraryID)throw new self.core.CloudError('请先点击“工具 → 网盘按需同步”，下载后再打开附件。');
        return self.native.download.call(this,item,...args);
      },
      stop:function(...args) {if(self.active)self.active.cancelled=true;return self.native.stop.apply(this,args);},
      addError:function(error,...args) {if(self.active)self.active.nativeErrors.push(error);return self.native.addError.call(this,error,...args);},
      controller:function(mode,options) {
        if(self.active&&mode==='webdav') {
          if(!self.active.controller)self.active.controller=self.makeController(self.active,options);
          return self.active.controller;
        }
        return self.native.controller.call(this,mode,options);
      },
      mode:function(id) {return self.active&&id===Zotero.Libraries.userLibraryID?'webdav':self.native.mode.call(this,id);},
      enabled:function(id) {
        if(self.config().consent&&id===Zotero.Libraries.userLibraryID)return !!self.active;
        return self.native.enabled.call(this,id);
      },
      onSync:function(id,enable) {if(self.active&&id===Zotero.Libraries.userLibraryID&&!enable)return true;return self.native.onSync.call(this,id,enable);},
      asNeeded:function(id,enable) {if(self.active&&id===Zotero.Libraries.userLibraryID&&!enable)return false;return self.native.asNeeded.call(this,id,enable);}
    };
    r.sync=this.wrappers.sync;r.downloadFile=this.wrappers.download;r.stop=this.wrappers.stop;r.getStorageController=this.wrappers.controller;
    if(this.native.addError)r.addError=this.wrappers.addError;
    l.getModeForLibrary=this.wrappers.mode;l.getEnabledForLibrary=this.wrappers.enabled;l.downloadOnSync=this.wrappers.onSync;l.downloadAsNeeded=this.wrappers.asNeeded;
    for(const w of Zotero.getMainWindows())this.addWindow(w);
  }
  addWindow(win) {
    if(!win||win.closed)return;
    const doc=win.document;if(doc.getElementById('cloud-on-demand-menu')){this.clearWindowRetry(win);return;}
    const popup=doc.getElementById('menu_ToolsPopup')||doc.getElementById('menu_Tools')?.menupopup;
    if(!popup){
      if(!this.pendingWindows.has(win)){
        const retry=()=>this.addWindow(win);
        this.pendingWindows.set(win,retry);
        win.addEventListener('DOMContentLoaded',retry);
        win.addEventListener('load',retry);
        win.addEventListener('popupshowing',retry,true);
      }
      return;
    }
    this.clearWindowRetry(win);
    const menu=doc.createXULElement('menu');menu.id='cloud-on-demand-menu';menu.setAttribute('label','网盘按需同步');
    const inner=doc.createXULElement('menupopup');
    for(const [label,fn]of [['开始附件同步',()=>this.run('sync')],['同步设置…',()=>this.openSettings(win)]]) {
      const item=doc.createXULElement('menuitem');item.setAttribute('label',label);
      item.addEventListener('command',()=>Promise.resolve().then(fn).catch(e=>this.showError(e,win)));inner.append(item);
    }
    menu.append(inner);popup.append(menu);
  }
  clearWindowRetry(win) {
    const retry=this.pendingWindows.get(win);if(!retry)return;
    win.removeEventListener('DOMContentLoaded',retry);
    win.removeEventListener('load',retry);
    win.removeEventListener('popupshowing',retry,true);
    this.pendingWindows.delete(win);
  }
  removeWindow(win) {this.clearWindowRetry(win);win.document.getElementById('cloud-on-demand-menu')?.remove();}
  openSettings(win=Zotero.getMainWindow()) {
    if(this.settingsWindow&&!this.settingsWindow.closed){this.settingsWindow.focus();return;}
    this.settingsWindow=win.openDialog('chrome://cloud-on-demand/content/settings.xhtml','cloud-on-demand-settings','chrome,dialog=no,centerscreen,resizable,width=880,height=800',this);
  }
  launchURL(url) {Zotero.launchURL(url);}
  operationError(error,stage) {
    if(error instanceof this.core.CloudError)return error;
    // Never display raw messages/stacks: native network exceptions may embed
    // a credential-bearing URL. Extract only bounded, known diagnostic fields.
    const details=[];
    try {
      if(['TypeError','ReferenceError','SyntaxError','RangeError','NS_ERROR_FAILURE','NS_ERROR_NOT_AVAILABLE','NS_ERROR_UNEXPECTED','NS_ERROR_INVALID_ARG','NS_ERROR_FILE_NOT_FOUND','NS_ERROR_XPC_BAD_CONVERT_JS','NS_ERROR_NOT_IMPLEMENTED'].includes(error?.name))details.push(error.name);
      if(typeof error?.result==='number'&&Number.isInteger(error.result))details.push('result=0x'+(error.result>>>0).toString(16));
      if(typeof error?.status==='number'&&Number.isInteger(error.status)&&error.status>=0&&error.status<=599)details.push('HTTP '+error.status);
      if(['NOT_DAV','NONEXISTENT_FILE_NOT_MISSING','FILE_MISSING_AFTER_UPLOAD','ZOTERO_DIR_NOT_FOUND','PARENT_DIR_NOT_FOUND','NO_URL','NO_USERNAME','NO_PASSWORD','INVALID_URL'].includes(error?.error))details.push(error.error);
      const frame=typeof error?.stack==='string'&&error.stack.match(/(?:^|[\s/@\\])((?:core|providers|runtime|settings|qrcode)\.js):(\d{1,6})(?::\d{1,6})?/m);
      if(frame)details.push(frame[1]+':'+frame[2]);
    }catch(_){}
    return new this.core.CloudError(stage+'失败'+(details.length?'（'+details.join('；')+'）':'')+'。请保留此提示以定位插件错误。');
  }
  async step(stage,fn) {
    try{return await fn();}catch(error){throw this.operationError(error,stage);}
  }
  cancelQuarkLogin() {
    if(!this.loginCancel)return;
    this.loginCancel.cancelled=true;this.loginCancel.abort?.();
  }
  cancelBaiduLogin(){this.cancelQuarkLogin();}
  async loginBaidu(inputs,onQR){
    if(this.busy||this.active||Zotero.Sync.Runner.syncInProgress)throw new this.core.CloudError('请等待当前任务结束后扫码登录。');
    const client=String(inputs?.client||'').trim(),secret=String(inputs?.secret||'').trim();
    if(!client||/[\r\n]/.test(client+secret)||client.length>256||secret.length>2048)throw new this.core.CloudError('请填写有效的百度 AppKey 和 SecretKey。');
    const cancel={cancelled:false,abort:null,provider:'baidu'};this.loginCancel=cancel;this.busy=true;this.setStatus('正在生成百度授权二维码…');
    this.running=(async()=>{
      const previous=await this.secrets();
      const effectiveSecret=secret||(this.config().baiduClient===client?previous.baiduSecret:'');
      const login=new this.providers.BaiduQRLogin({baiduClient:client},{baiduSecret:effectiveSecret},this.env(),cancel);
      const tokens=await login.run(onQR);
      if(cancel.cancelled)throw new this.core.CloudError('百度扫码登录已取消。');
      const next={...previous,baiduSecret:effectiveSecret,...tokens};
      const encrypted=await Zotero.OSKeyStore.encrypt(JSON.stringify(next));
      if(cancel.cancelled)throw new this.core.CloudError('百度扫码登录已取消。');
      const presence={};for(const key of ['quarkCookie','baiduSecret','baiduAccess','baiduRefresh'])presence[key]=!!next[key];
      this.branch.setStringPref('credentials',encrypted);this.branch.setStringPref('credentialPresence',JSON.stringify(presence));
      this.branch.setStringPref('config',JSON.stringify({...this.config(),baiduClient:client}));
      Services.prefs.savePrefFile(null);this.setStatus('百度扫码授权成功，Token 已加密保存。请填写专用目录并保存配置。','success');
    })();
    try{await this.running;}
    catch(e){const error=cancel.cancelled?Object.assign(new this.core.CloudError('百度扫码登录已取消。'),{cancelled:true}):this.operationError(e,'百度扫码授权或凭据保存');this.setStatus(error.message,error.cancelled?'warning':'error');throw error;}
    finally{this.loginCancel=null;this.busy=false;this.running=null;this.setStatus(this.status,this.statusTone);}
  }
  async loginQuark(onQR) {
    if(this.busy||Zotero.Sync.Runner.syncInProgress)throw new this.core.CloudError('请等待当前任务结束后扫码登录。');
    const cancel={cancelled:false,abort:null,provider:'quark'};this.loginCancel=cancel;this.busy=true;
    this.setStatus('正在生成夸克登录二维码…');
    this.running=(async()=>{
      const login=new this.providers.QuarkQRLogin(this.env(),cancel);
      let cookie=await login.run(onQR);
      if(cancel.cancelled)throw new this.core.CloudError('扫码登录已取消。');
      const secrets=await this.secrets();
      if(cancel.cancelled)throw new this.core.CloudError('扫码登录已取消。');
      secrets.quarkCookie=cookie;cookie='';
      // Encrypt first, then commit only if the login has not been cancelled.
      const encrypted=await Zotero.OSKeyStore.encrypt(JSON.stringify(secrets));
      if(cancel.cancelled)throw new this.core.CloudError('扫码登录已取消。');
      const presence={};for(const key of ['quarkCookie','baiduSecret','baiduAccess','baiduRefresh'])presence[key]=!!secrets[key];
      this.branch.setStringPref('credentials',encrypted);
      this.branch.setStringPref('credentialPresence',JSON.stringify(presence));
      Services.prefs.savePrefFile(null);
      this.setStatus('夸克扫码登录成功，凭据已加密保存到本机。请填写专用目录并保存配置。','success');
    })();
    try {await this.running;}
    catch(e){const error=cancel.cancelled?Object.assign(new this.core.CloudError('扫码登录已取消。'),{cancelled:true}):e instanceof this.core.CloudError?e:new this.core.CloudError('夸克扫码登录或凭据保存失败，请重试。');this.setStatus(error.message,error.cancelled?'warning':'error');throw error;}
    finally{this.loginCancel=null;this.busy=false;this.running=null;this.setStatus(this.status,this.statusTone);}
  }
  showError(e,win=Zotero.getMainWindow(),{inline=false}={}) {
    const msg=this.operationError(e,'插件操作').message;
    this.setStatus(msg,'error');
    if(!inline)Services.prompt.alert(win,'网盘按需同步',msg);
  }
  async startSession(config) {
    const secrets=await this.step('读取本机凭据',()=>this.secrets());
    const provider=await this.step('初始化网盘适配器',()=>this.providers.create(config,secrets,this.env()));
    try {await this.step('网盘登录与专用目录检查',()=>provider.init());}catch(e){try{await provider.dispose();}catch(_){}throw e;}
    try {
    const {HttpServer}=await this.step('加载本地 WebDAV 组件',()=>ChromeUtils.importESModule('chrome://remote/content/server/httpd.sys.mjs'));
    const server=new HttpServer(),token=this.random(),password=this.random(),prefix='/'+token+'/';
    const auth='Basic '+this.bytes64(this.core.utf8('cloud:'+password));
    const dav=new this.core.DAV(provider,{prefix,authorization:auth,maxBytes:config.maxMB*1048576});
    const s={provider,server,dav,prefix,password,auth,cancelled:false,controller:null,handlers:new Set(),nativeErrors:[]};
    server.registerPrefixHandler('/',(request,response)=>{
      response.processAsync();
      const operation=(async()=>{
        let result;
        try {
          const headers={};for(const key of ['authorization','origin','depth','host','content-length'])if(request.hasHeader(key))headers[key]=request.getHeader(key);
          if(headers.host!=='127.0.0.1:'+server.identity.primaryPort)result={status:403};
          else if(headers.authorization!==auth)result={status:401,headers:{'WWW-Authenticate':'Basic realm="CloudOnDemand"'}};
          else {
            let body=new Uint8Array();
            if(request.method==='PUT') {
              const input=Components.classes['@mozilla.org/binaryinputstream;1'].createInstance(Components.interfaces.nsIBinaryInputStream);
              input.setInputStream(request.bodyInputStream);
              const size=input.available();
              if(size>dav.maxBytes){result={status:413};}else body=Uint8Array.from(input.readByteArray(size));
            }
            if(!result)result=await dav.handle({method:request.method,path:request.path,headers,body});
          }
          response.setStatusLine(request.httpVersion,result.status,({200:'OK',201:'Created',204:'No Content',207:'Multi-Status',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',405:'Method Not Allowed',413:'Content Too Large',502:'Bad Gateway',503:'Unavailable'})[result.status]||'Error');
          response.setHeader('Cache-Control','no-store',false);response.setHeader('Connection','close',false);
          for(const [key,value]of Object.entries(result.headers||{}))response.setHeader(key,value,false);
          if(result.body?.length&&request.method!=='HEAD') {
            const output=Components.classes['@mozilla.org/binaryoutputstream;1'].createInstance(Components.interfaces.nsIBinaryOutputStream);output.setOutputStream(response.bodyOutputStream);
            for(let i=0;i<result.body.length;i+=32768){const chunk=Array.from(result.body.subarray(i,i+32768));output.writeByteArray(chunk,chunk.length);}
          }
        }catch(_) {
          dav.failure=new this.core.CloudError('本地 WebDAV 请求未完整处理。');
          try{response.setStatusLine(request.httpVersion,502,'Bad Gateway');}catch(_){}
        }finally {try{response.finish();}catch(_){}}
      })();
      s.handlers.add(operation);operation.finally(()=>s.handlers.delete(operation));
    });
    let listening=false;
    try {
      server._start(-1,'127.0.0.1');listening=true;
      // Gecko's ServerIdentity._initialize() chooses localhost as primary,
      // even when the socket is bound to 127.0.0.1. With this bind address it
      // does not add the numeric host, so native requests fail with HTTP 400
      // before our authenticated handler runs. Register the exact endpoint.
      const port=server.identity.primaryPort;
      server.identity.setPrimary('http','127.0.0.1',port);
      s.base='http://127.0.0.1:'+port+prefix;
    }
    catch(e) {
      if(listening){try{await server.stop();}catch(cleanup){this.active=s;throw new this.core.CloudError(this.operationError(e,'登记本地 WebDAV 地址').message+' '+this.operationError(cleanup,'关闭本地 WebDAV 服务').message);}}
      throw this.operationError(e,'启动本机临时 WebDAV 服务');
    }
    this.active=s;return s;
    }catch(error){try{await provider.dispose();}catch(_){}throw this.operationError(error,'准备本地 WebDAV 服务');}
  }
  makeController(s,options) {
    const c=new Zotero.Sync.Storage.Mode.WebDAV(options);
    let verified=false;Object.defineProperty(c,'verified',{get:()=>verified,set:v=>{verified=!!v;},configurable:true});
    Object.defineProperty(c,'username',{get:()=> 'cloud',configurable:true});c.getPassword=async()=>s.password;
    c._init=async()=>{
      if(c._rootURI)return;
      const base=s.base.replace('http://','http://cloud:'+s.password+'@');
      c._parentURI=Services.io.newURI(base);c._rootURI=Services.io.newURI(base+'zotero/');c._basicAuthHeader=s.auth;
    };
    // The prototype does not perform automatic orphan sweeps on an existing cloud folder.
    c.purgeOrphanedStorageFiles=async()=>false;
    return c;
  }
  async stopSession(s) {
    await s.dav.drain();await Promise.allSettled(Array.from(s.handlers));
    // Keep active set if stopping the listener fails; do not falsely report
    // that a possibly open service has been closed or permit a second one.
    await this.step('关闭本地 WebDAV 服务',()=>s.server.stop());
    try {await this.step('清理临时网盘凭据',()=>s.provider.dispose());}
    finally {if(this.active===s)this.active=null;s.password='';s.auth='';s.controller=null;}
  }
  async testSession(s) {
    const name='cod-test-'+this.random()+'.prop',bytes=this.core.utf8('Cloud On Demand '+this.random());
    let created=false,failure=null;
    try {
      this.setStatus('测试 1/4：上传临时文件…');
      const put=await s.dav.handle({method:'PUT',path:s.prefix+'zotero/'+name,headers:{authorization:s.auth},body:bytes});
      if(put.status!==204)throw s.dav.failure||new this.core.CloudError('写入测试失败。');created=true;
      this.setStatus('测试 2/4：下载并比较内容…');
      const get=await s.dav.handle({method:'GET',path:s.prefix+'zotero/'+name,headers:{authorization:s.auth}});
      if(get.status!==200)throw s.dav.failure||new this.core.CloudError('测试文件下载失败。');
      if(get.body.length!==bytes.length||get.body.some((v,i)=>v!==bytes[i]))throw new this.core.CloudError('上传后读回内容校验失败。');
    }catch(error){failure=error;}finally {
      if(created) {
        this.setStatus('测试 3/4：清理临时测试文件…');
        const removed=await s.dav.handle({method:'DELETE',path:s.prefix+'zotero/'+name,headers:{authorization:s.auth}});
        if(removed.status!==204){
          const cleanup='测试文件清理失败，请检查专用目录中的 cod-test 文件。';
          if(failure){const first=failure instanceof this.core.CloudError?failure.message:'测试失败。';failure=new this.core.CloudError(first+' '+cleanup);}
          else failure=s.dav.failure||new this.core.CloudError(cleanup);
        }
      }
    }
    if(failure)throw failure;
    this.setStatus('测试 4/4：Zotero 原生 WebDAV 验证…');
    await this.step('Zotero 原生 WebDAV 验证',async()=>{const controller=this.makeController(s,{});await controller.checkServer();});
  }
  async run(kind) {
    if(this.busy||this.active)throw new this.core.CloudError('已有网盘任务正在运行，或上次本地服务尚未关闭；请先重启 Zotero。');
    if(Zotero.Sync.Runner.syncInProgress)throw new this.core.CloudError('请等待当前 Zotero 同步结束后重试。');
    const config=this.core.validateConfig(this.config());
    if(!config.consent) {this.openSettings();throw new this.core.CloudError('请先在插件设置中确认实验版说明并保存。');}
    this.busy=true;
    this.running=(async()=>{
      let session,failure;
      try {
        this.setStatus('正在连接'+(config.provider==='baidu'?'百度':'夸克')+'；完成后自动关闭本地接口…');
        session=await this.startSession(config);
        if(kind==='test') {await this.step('上传、下载和删除测试',()=>this.testSession(session));}
        else {
          if(!Zotero.Users.getCurrentUserID())throw new this.core.CloudError('请先登录 Zotero 账号并完成一次条目同步。');
          const key=this.hash('sha1',this.core.utf8(String(Zotero.Users.getCurrentUserID())+':'+session.provider.identity));
          const binding=this.branch.getStringPref('target','');
          if(binding!==key) {
            this.setStatus('首次使用此网盘目录；正在重新检查本地附件的同步状态…');
            await this.step('重置附件同步状态',()=>Zotero.Sync.Storage.Local.resetAllSyncStates(Zotero.Libraries.userLibraryID));
            this.branch.setStringPref('target',key);
          }
          const errors=[];
          this.setStatus('正在调用 Zotero 原生同步。附件写入完成后关闭临时接口…');
          const result=await this.step('Zotero 原生附件同步',()=>this.native.sync.call(Zotero.Sync.Runner,{background:false,libraries:[Zotero.Libraries.userLibraryID],fileLibraries:[Zotero.Libraries.userLibraryID],onError:e=>errors.push(e)}));
          await session.dav.tail;
          if(session.cancelled||result===false)throw new this.core.CloudError('本次同步已取消；已等待正在进行的网盘操作结束。');
          if(errors.length||session.nativeErrors.length||session.dav.failure)throw session.dav.failure||new this.core.CloudError('Zotero 报告同步错误，请查看原生同步错误详情；本轮未确认成功。');
        }
        if(session.dav.failure)throw session.dav.failure;
      }catch(error){failure=this.operationError(error,'网盘任务');}finally {
        if(session){try{await this.stopSession(session);}catch(error){const cleanup=this.operationError(error,'清理临时同步会话');failure=failure?new this.core.CloudError(failure.message+' '+cleanup.message):cleanup;}}
      }
      if(failure)throw failure;
      this.active=null;
      this.setStatus((kind==='test'?'上传、读回、删除和原生 WebDAV 检查通过。':'Zotero 同步流程结束，未报告错误。')+'临时 WebDAV 接口已关闭。','success');
    })();
    try {return await this.running;}
    catch(e) {const error=this.operationError(e,'网盘任务');this.setStatus(error.message+(this.active?' 本地接口仍在清理。':' 临时 WebDAV 接口已关闭。'),'error');throw error;}
    finally {this.busy=false;this.running=null;this.setStatus(this.status,this.statusTone);}
  }
  async exchange(code) {
    if(this.busy)throw new this.core.CloudError('请等待当前任务结束。');
    const config=this.config(),secrets=await this.secrets();
    if(!config.baiduClient||!secrets.baiduSecret||!code)throw new this.core.CloudError('请先保存 AppKey 和 SecretKey，然后输入授权码。');
    const p=new this.providers.Baidu(config,secrets,this.env());
    try{await p.exchange(code.trim());this.setStatus('已通过百度官方接口取得 Token，并加密保存在本机。','success');}finally{await p.dispose();}
  }
  async shutdown() {
    if(this.loginCancel){this.cancelQuarkLogin();try{await this.running;}catch(_){}}
    else if(this.busy){Zotero.Sync.Runner.stop();try{await this.running;}catch(_){}}
    if(this.active){try{await this.stopSession(this.active);}catch(error){this.setStatus(this.operationError(error,'关闭本地 WebDAV 服务').message);}}
    const r=Zotero.Sync.Runner,l=Zotero.Sync.Storage.Local,w=this.wrappers;if(!w)return;
    for(const [object,key,wrapper,native]of [[r,'sync','sync','sync'],[r,'downloadFile','download','download'],[r,'stop','stop','stop'],[r,'getStorageController','controller','controller'],[l,'getModeForLibrary','mode','mode'],[l,'getEnabledForLibrary','enabled','enabled'],[l,'downloadOnSync','onSync','onSync'],[l,'downloadAsNeeded','asNeeded','asNeeded']])if(object[key]===w[wrapper])object[key]=this.native[native];
    if(r.addError===w.addError)r.addError=this.native.addError;
    for(const win of Zotero.getMainWindows())this.removeWindow(win);
    for(const win of Array.from(this.pendingWindows.keys()))this.clearWindowRetry(win);
    if(this.settingsWindow&&!this.settingsWindow.closed)this.settingsWindow.close();
  }
};
