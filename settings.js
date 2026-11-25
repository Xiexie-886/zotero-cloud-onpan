/* SPDX-License-Identifier: AGPL-3.0-or-later */
(() => {
  const runtime=window.arguments?.[0]?.wrappedJSObject || window.arguments?.[0];
  const $=id=>document.getElementById(id);
  const providerInputs=['provider-quark','provider-baidu'];
  const secretFields=['quark-cookie','baidu-secret','baidu-access','baidu-refresh'];
  const actions={
    'save-top':'正在保存配置','save':'正在保存配置','sync':'正在同步附件',
    'quark-login':'夸克扫码登录','baidu-login':'百度扫码登录',
    'baidu-auth':'正在打开授权页','baidu-exchange':'正在换取授权',
  };
  const drafts=new Map();
  let initialized=false,available=false,pending='',previousStatus='',focusAfterAction='',dirty=false,revision=0;

  function text(id,value) {
    const element=$(id);
    if(element.textContent!==value)element.textContent=value;
  }
  function savedState() {
    return runtime.configurationState?.()||{savedAt:'',hasEncryptedCredentials:false,credentials:{}};
  }
  function markDirty() {dirty=true;revision++;renderConfigurationState();}
  function renderConfigurationState() {
    const saved=savedState(),cookie=$('quark-cookie').value;
    const hasCookie=!!saved.credentials.quarkCookie;
    const hasBaidu=!!(saved.credentials.baiduAccess&&saved.credentials.baiduRefresh);
    $('config-state').dataset.state=dirty?'dirty':saved.savedAt?'saved':'initial';
    text('config-state',dirty?'有未保存的更改':saved.savedAt?'配置已保存到本机':'尚未保存配置');
    text('quark-cookie-state',cookie?(cookie===drafts.get('saved-cookie')?'Cookie 已加密保存；输入内容仅保留到关闭窗口。':'Cookie 已输入，尚未保存。'):hasCookie?'已保存 Cookie；留空保留，重新填写可替换。':saved.hasEncryptedCredentials?'本机已有加密凭据；留空不会删除已有 Cookie。':'尚未保存 Cookie。');
    const unknown=!!saved.hasEncryptedCredentials&&!Object.keys(saved.credentials).length;
    $('quark-auth-state').dataset.state=hasCookie?'saved':unknown?'unknown':'initial';
    text('quark-auth-state',hasCookie?'夸克登录凭据已加密保存':unknown?'本机已有加密凭据，未确认夸克授权':'尚未保存登录凭据');
    $('baidu-login-state').dataset.state=hasBaidu?'saved':unknown?'unknown':'initial';
    text('baidu-login-state',hasBaidu?'已保存百度授权凭据':unknown?'本机已有加密凭据，未确认百度授权':'尚未保存完整授权');
  }
  function task(tone,title,message) {
    $('task-state').dataset.tone=tone;
    text('task-title',title);text('status',message);
  }
  function displayError(error) {
    const message=runtime?.operationError?.(error,'设置窗口加载')?.message || '设置窗口加载失败，请关闭后重新打开。';
    task('error','设置不可用',message);
  }
  function provider() {return $('provider-baidu').checked?'baidu':'quark';}
  function selected() {
    const baidu=provider()==='baidu';
    $('baidu-panel').hidden=$('baidu-directory').hidden=!baidu;
    $('quark-panel').hidden=$('quark-directory').hidden=baidu;
  }
  function state() {
    if(!available)return;
    for(const id of Object.keys(actions))$(id).disabled=!!pending||runtime.busy;
    const login=runtime.loginCancel;
    for(const name of ['quark','baidu']){
      const active=!!login&&(login.provider||'quark')===name;
      const cancel=$(name+'-login-cancel');
      cancel.hidden=!active;cancel.disabled=!active||!!login.cancelled;
    }
    for(const id of [...providerInputs,'baidu-client',...secretFields,'baidu-code'])$(id).disabled=!!login;
    if(pending||runtime.busy) {
      const message=runtime.busy||runtime.status!==previousStatus?runtime.status:'请稍候…';
      task('busy',actions[pending]||'正在处理网盘任务',message);
    } else {
      const tone=runtime.statusTone||'info';
      task(tone,({error:'操作未完成',warning:'任务已取消',success:'操作完成'})[tone]||'任务状态',runtime.status);
    }
    renderConfigurationState();
  }
  function config() {
    return {provider:provider(),quarkPath:$('quark-folder').value.trim(),baiduFolder:$('baidu-folder').value.trim(),baiduClient:$('baidu-client').value.trim(),maxMB:Number($('max-mb').value),consent:$('consent').checked};
  }
  async function save() {
    const startedRevision=revision,cookie=$('quark-cookie').value;
    await runtime.saveSettings(config(),{quarkCookie:cookie,baiduSecret:$('baidu-secret').value,baiduAccess:$('baidu-access').value,baiduRefresh:$('baidu-refresh').value});
    drafts.set('saved-cookie',cookie);
    if(revision===startedRevision)dirty=false;
    renderLegacyDirectory(runtime.config());
    renderConfigurationState();
  }
  function action(id,fn) {
    $(id).addEventListener('click',event=>{
      event?.preventDefault?.();if(!available||pending||runtime.busy)return;
      pending=id;previousStatus=runtime.status;state();
      return Promise.resolve().then(fn).catch(error=>{
        if(!window.closed&&!error.cancelled)runtime.showError(error,window,{inline:true});
      }).finally(()=>{
        pending='';
        if(!window.closed){
          state();
          if(focusAfterAction)$(focusAfterAction).focus();
        }
        focusAfterAction='';
      });
    });
  }
  function revealQR(name,url) {
    if(window.closed)return;
    const qr=qrcode(0,'M');qr.addData(url);qr.make();
    $(name+'-qr').src=qr.createDataURL(5,20);
    $(name+'-qr-panel').hidden=false;
    const heading=$(name+'-qr-heading');
    heading.focus();
    $(name+'-qr-panel').scrollIntoView({block:'nearest'});
  }
  function clearQR(name,restoreFocus=false) {
    const panel=$(name+'-qr-panel');
    const active=document.activeElement;
    const shouldRestore=restoreFocus&&!window.closed&&(panel.contains(active)||active===$(name+'-login-cancel')||active===document.body);
    panel.hidden=true;$(name+'-qr').removeAttribute('src');
    if(name==='baidu')text('baidu-user-code','');
    // The action's finally re-enables the button before returning focus.
    if(shouldRestore)focusAfterAction=name+'-login';
  }
  function renderLegacyDirectory(saved) {
    $('quark-legacy').hidden=!!(saved.quarkPath || !saved.quarkFolder);
  }
  function startSync() {
    if(!$('consent').checked){
      focusAfterAction='consent';
      throw new runtime.core.CloudError('请先阅读并勾选实验版确认，再继续。');
    }
    return save().then(()=>runtime.run('sync'));
  }
  function initialize() {
    if(initialized)return;initialized=true;
    try {
      if(!runtime){task('error','设置不可用','请从 Zotero 的工具菜单打开此设置窗口。');return;}
      const c=runtime.config();
      $(c.provider==='baidu'?'provider-baidu':'provider-quark').checked=true;
      $('quark-folder').value=c.quarkPath||'';$('baidu-folder').value=c.baiduFolder;
      renderLegacyDirectory(c);
      $('baidu-client').value=c.baiduClient;$('max-mb').value=c.maxMB;$('consent').checked=c.consent;
      for(const id of providerInputs){
        $(id).addEventListener('change',()=>{if($(id).checked){selected();markDirty();}});
      }
      for(const id of ['quark-folder','baidu-folder','baidu-client','max-mb','consent',...secretFields]){
        const onEdit=()=>{if(secretFields.includes(id))drafts.set(id,$(id).value);markDirty();};
        $(id).addEventListener('input',onEdit);$(id).addEventListener('change',onEdit);
      }
      for(const id of secretFields){
        const field=$(id);
        drafts.set(id,field.value);
        field.addEventListener('blur',()=>{
          // Preserve an explicit draft if a privileged input clears on blur;
          // an intentional deletion already updated the draft via input.
          Promise.resolve().then(()=>{const draft=drafts.get(id);if(!field.value&&draft)field.value=draft;renderConfigurationState();});
        });
      }
      action('save-top',save);
      action('save',save);
      action('sync',startSync);
      $('quark-login-cancel').addEventListener('click',()=>{runtime.cancelQuarkLogin();state();});
      $('baidu-login-cancel').addEventListener('click',()=>{runtime.cancelBaiduLogin();state();});
      action('baidu-login',async()=>{
        try {
          await runtime.loginBaidu({client:$('baidu-client').value.trim(),secret:$('baidu-secret').value.trim()},(url,userCode)=>{
            if(window.closed)return;
            text('baidu-user-code',userCode);revealQR('baidu',url);
          });
          // Do not let a stale manual draft overwrite freshly granted credentials.
          for(const id of ['baidu-secret','baidu-access','baidu-refresh']){$(id).value='';drafts.set(id,'');}
        } finally {clearQR('baidu',true);}
      });
      action('quark-login',async()=>{
        try {
          await runtime.loginQuark(url=>revealQR('quark',url));
          $('quark-cookie').value='';drafts.set('quark-cookie','');drafts.delete('saved-cookie');
        } finally {clearQR('quark',true);}
      });
      action('baidu-auth',()=>{
        const client=$('baidu-client').value.trim();
        if(!client){focusAfterAction='baidu-client';throw new runtime.core.CloudError('请先填写自己的百度 AppKey。');}
        const q=new URLSearchParams({response_type:'code',client_id:client,redirect_uri:'oob',scope:'basic,netdisk',display:'page'});
        runtime.launchURL('https://openapi.baidu.com/oauth/2.0/authorize?'+q.toString());
      });
      action('baidu-exchange',async()=>{await save();await runtime.exchange($('baidu-code').value);$('baidu-code').value='';});
      available=true;selected();state();
    } catch(error){available=false;displayError(error);}
    finally {if(!available)for(const id of Object.keys(actions))$(id).disabled=true;}
  }
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',initialize,{once:true});
  else initialize();
  window.addEventListener('cloud-state',state);
  window.addEventListener('error',event=>displayError(event.error||event.message));
  window.addEventListener('beforeunload',event=>{if(!dirty&&!pending)return;event.preventDefault();event.returnValue='';});
  window.addEventListener('unload',()=>{
    if(runtime?.loginCancel?.provider==='baidu')runtime.cancelBaiduLogin?.();else runtime?.cancelQuarkLogin?.();
    clearQR('quark');clearQR('baidu');
    for(const id of [...secretFields,'baidu-code'])$(id).value='';
    drafts.clear();
  });
})();
