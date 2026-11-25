/* SPDX-License-Identifier: AGPL-3.0-or-later
 * Protocol references: OpenListTeam/OpenList drivers/baidu_netdisk and drivers/quark_uc.
 * See THIRD_PARTY.md for provenance and license. */
var CloudProviders = (() => {
  const E = CloudCore.CloudError;
  const form = data => new URLSearchParams(Object.entries(data).map(([k,v]) => [k,String(v)])).toString();
  const query = (url, data) => { const u = new URL(url); for (const [k,v] of Object.entries(data)) u.searchParams.set(k,String(v)); return u.href; };
  const parseJSON = text => JSON.parse(text.replace(/([,{]\s*"(?:fs_id|uk|fsid)"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"'));
  function unique(files, name) {
    const matches = files.filter(f => f.name === name);
    if (matches.length > 1) throw new E('同步目录中存在同名文件，请先在网盘端处理重名。');
    return matches[0] || null;
  }
  class Base {
    constructor(config, secrets, env) { this.config=config; this.secrets=secrets; this.env=env; this.root=null; }
    async stat(name) { return unique(await this.list(), name); }
    async waitFor(name, predicate) {
      for (let i=0;i<9;i++) {
        const f = await this.stat(name); if (predicate(f)) return f;
        await this.env.delay(Math.min(250*2**i,2000));
      }
      throw new E('网盘尚未确认文件状态，已停止本轮同步。');
    }
    async verifiedFile(name, bytes) {
      return this.waitFor(name, f => f && !f.dir && f.size === bytes.length);
    }
    async dispose() { this.secrets = {}; this.root=null; }
  }
  class Baidu extends Base {
    async oauth(params) {
      const r = await this.env.request({provider:'baidu',kind:'api',method:'POST',url:'https://openapi.baidu.com/oauth/2.0/token',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form(params)});
      const j = parseJSON(new TextDecoder().decode(r.bytes));
      if (j.error || !j.access_token || !j.refresh_token) throw new E('百度授权失败，请检查应用信息和授权码。');
      this.secrets.baiduAccess=j.access_token; this.secrets.baiduRefresh=j.refresh_token;
      await this.env.saveSecrets(this.secrets); return true;
    }
    async exchange(code) {
      return this.oauth({grant_type:'authorization_code',code,client_id:this.config.baiduClient,client_secret:this.secrets.baiduSecret,redirect_uri:'oob'});
    }
    async refresh() {
      if (!this.config.baiduClient || !this.secrets.baiduSecret || !this.secrets.baiduRefresh) throw new E('百度 Token 已过期，请补全自己的 AppKey、SecretKey 和 Refresh Token。',401);
      return this.oauth({grant_type:'refresh_token',refresh_token:this.secrets.baiduRefresh,client_id:this.config.baiduClient,client_secret:this.secrets.baiduSecret});
    }
    async api(path, method, params = {}, body = null, retry = true) {
      if (!this.secrets.baiduAccess) await this.refresh();
      const r = await this.env.request({provider:'baidu',kind:'api',method,url:query('https://pan.baidu.com/rest/2.0'+path,{...params,access_token:this.secrets.baiduAccess}),headers:body?{'Content-Type':'application/x-www-form-urlencoded'}:{},body:body?form(body):null});
      const j = parseJSON(new TextDecoder().decode(r.bytes));
      const code=Number(j.errno || j.error_code || 0);
      if ([110,111,-6,20016,20017].includes(code) && retry) { await this.refresh(); return this.api(path,method,params,body,false); }
      if (code) throw new E('百度接口返回错误 '+code+'，请检查权限、登录状态及目录。');
      return j;
    }
    async init() {
      const j = await this.api('/xpan/nas','GET',{method:'uinfo'});
      if (!j.uk) throw new E('无法确认百度账号身份。');
      this.identity = 'baidu:'+j.uk+':'+this.config.baiduFolder;
      await this.ensureRoot();
    }
    async rawList(path) {
      const rows=[];
      for (let start=0;start<1000000;start+=1000) {
        const j=await this.api('/xpan/file','GET',{method:'list',dir:path,start,limit:1000,web:'web'});
        if (!Array.isArray(j.list)) throw new E('百度目录列表响应异常。');
        rows.push(...j.list.map(f=>({id:String(f.fs_id),name:f.server_filename,size:Number(f.size),dir:!!f.isdir,modified:Number(f.server_mtime||f.local_mtime)*1000,md5:f.md5})));
        if (j.list.length<1000) return rows;
      }
      throw new E('同步目录文件过多。');
    }
    async ensureRoot() {
      if (this.root) return;
      let entry=unique(await this.rawList(this.config.baiduFolder),'zotero');
      if (!entry) {
        await this.api('/xpan/file','POST',{method:'create'},{path:this.config.baiduFolder+'/zotero',isdir:1,size:0,rtype:0});
        entry=unique(await this.rawList(this.config.baiduFolder),'zotero');
      }
      if (!entry?.dir) throw new E('百度专用目录中无法创建 zotero 子目录。');
      this.root=this.config.baiduFolder+'/zotero';
    }
    async list() { await this.ensureRoot(); return this.rawList(this.root); }
    async get(name) {
      const f=await this.stat(name); if (!f || f.dir) throw new E('File not found',404);
      const j=await this.api('/xpan/multimedia','GET',{method:'filemetas',fsids:'['+f.id+']',dlink:1});
      const link=j.list?.[0]?.dlink; if (!link) throw new E('百度未返回下载地址。');
      const u=CloudCore.validateURL(link,'baidu','download');
      // An access token is only attached to a Baidu-owned PCS endpoint.
      if (!(u.hostname==='baidu.com'||u.hostname.endsWith('.baidu.com')||u.hostname.endsWith('.baidupcs.com')||u.hostname==='baidupcs.com')) throw new E('百度下载端点不允许附加账号 Token。');
      u.searchParams.set('access_token',this.secrets.baiduAccess);
      const r=await this.env.request({provider:'baidu',kind:'download',url:u.href,method:'GET',headers:{'User-Agent':'pan.baidu.com'},maxBytes:this.config.maxMB*1048576,redirects:5});
      if (r.bytes.length!==f.size) throw new E('百度下载文件大小校验失败。');
      return r.bytes;
    }
    async put(name, bytes) {
      await this.ensureRoot();
      const path=this.root+'/'+name, size=4*1048576, blocks=[];
      for (let i=0;i<bytes.length;i+=size) blocks.push(this.env.hash('md5',bytes.subarray(i,i+size)));
      const now=Math.floor(Date.now()/1000);
      const pre=await this.api('/xpan/file','POST',{method:'precreate'},{path,size:bytes.length,isdir:0,autoinit:1,rtype:3,block_list:JSON.stringify(blocks),'content-md5':this.env.hash('md5',bytes),'slice-md5':this.env.hash('md5',bytes.subarray(0,262144)),local_ctime:now,local_mtime:now});
      if (Number(pre.return_type)!==2) {
        if (!pre.uploadid || !Array.isArray(pre.block_list)) throw new E('百度预上传响应异常。');
        for (const part of pre.block_list) {
          if (!Number.isInteger(part)||part<0||part>=blocks.length) throw new E('百度上传分片编号无效。');
          const chunk=bytes.subarray(part*size,Math.min((part+1)*size,bytes.length));
          const boundary='----CloudOnDemand'+this.env.random();
          const head=CloudCore.utf8('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="part.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');
          const tail=CloudCore.utf8('\r\n--'+boundary+'--\r\n');
          const body=new Uint8Array(head.length+chunk.length+tail.length);body.set(head);body.set(chunk,head.length);body.set(tail,head.length+chunk.length);
          let done=false;
          for (let attempt=0;attempt<3;attempt++) {
            try {
              const r=await this.env.request({provider:'baidu',kind:'upload',url:query('https://d.pcs.baidu.com/rest/2.0/pcs/superfile2',{method:'upload',access_token:this.secrets.baiduAccess,type:'tmpfile',path,uploadid:pre.uploadid,partseq:part}),method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary},body});
              const j=parseJSON(new TextDecoder().decode(r.bytes));
              if (j.errno||j.error_code||!j.md5||j.md5.toLowerCase()!==blocks[part]) throw new E('百度上传分片校验失败。');
              done=true;break;
            } catch(e) { if(attempt===2)throw e; await this.env.delay(500*2**attempt); }
          }
          if (!done) throw new E('百度上传未完成。');
        }
        await this.api('/xpan/file','POST',{method:'create'},{path,size:bytes.length,isdir:0,rtype:3,uploadid:pre.uploadid,block_list:JSON.stringify(blocks),local_ctime:now,local_mtime:now});
      }
      await this.verifiedFile(name,bytes);
    }
    async remove(name) {
      if (!await this.stat(name)) return;
      await this.api('/xpan/file','POST',{method:'filemanager',opera:'delete'},{async:0,filelist:JSON.stringify([this.root+'/'+name])});
      await this.waitFor(name,f=>!f);
    }
  }
  class Quark extends Base {
    headers() { return {Cookie:this.secrets.quarkCookie,Referer:'https://pan.quark.cn/','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'}; }
    async api(path, method='GET', data=null, params={}) {
      if (!this.secrets.quarkCookie) throw new E('请先填写夸克 Cookie。',401);
      const r=await this.env.request({provider:'quark',kind:'api',url:query('https://drive-pc.quark.cn/1/clouddrive'+path,{pr:'ucpro',fr:'pc',...params}),method,headers:{...this.headers(),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):null});
      let changed=false;
      for (const cookie of r.cookies || []) {
        if (!/^__(?:puus|pus)=/.test(cookie)) continue;
        const pair=cookie.split(';')[0], key=pair.split('=')[0];
        const parts=this.secrets.quarkCookie.split(';').map(s=>s.trim()).filter(s=>s&&!s.startsWith(key+'='));
        parts.push(pair);this.secrets.quarkCookie=parts.join('; ');changed=true;
      }
      if(changed)await this.env.saveSecrets(this.secrets);
      const j=parseJSON(new TextDecoder().decode(r.bytes));
      if (Number(j.code||0)!==0 || Number(j.status||200)>=400) {
        const stage=CloudCore.requestStage({provider:'quark',kind:'api',url:'https://drive-pc.quark.cn/1/clouddrive'+path});
        throw new E(stage+'失败：接口错误码 '+Number(j.code||j.status)+'。');
      }
      return j;
    }
    async init() {
      await this.api('/config');
      await this.ensureRoot();
      // Keep the same sync binding when a path resolves to the old configured ID.
      this.identity='quark:'+this.parentID;
    }
    async rawList(id) {
      const rows=[];
      for(let page=1;page<=10000;page++) {
        const j=await this.api('/file/sort','GET',null,{pdir_fid:id,_page:page,_size:100,_fetch_total:1,fetch_all_file:1,fetch_risk_file_name:1,_sort:'file_type:asc,file_name:asc'});
        if(!Array.isArray(j.data?.list))throw new E('夸克目录列表响应异常。');
        rows.push(...j.data.list.map(f=>({id:typeof f.fid==='string'||Number.isSafeInteger(f.fid)?String(f.fid):'',name:f.file_name,dir:f.file===false||f.file_type===0,size:Number(f.size||0),modified:Number(f.updated_at||f.l_updated_at||Date.now()),md5:f.md5})));
        const total=Number(j.metadata?._total);
        if(j.data.list.length<100 || (Number.isFinite(total)&&rows.length>=total))return rows;
      }
      throw new E('同步目录文件过多。');
    }
    async resolveParentID() {
      if(!this.config.quarkPath&&CloudCore.isQuarkFolderID(this.config.quarkFolder))return this.config.quarkFolder;
      let id='0'; // List from the root; never use it as an attachment destination.
      const seen=new Set([id]),parts=CloudCore.quarkPathParts(this.config.quarkPath);
      for(let i=0;i<parts.length;i++) {
        const matches=(await this.rawList(id)).filter(entry=>entry.name===parts[i]);
        if(matches.length!==1 || !matches[0].dir || !CloudCore.isQuarkFolderID(matches[0].id) || seen.has(matches[0].id)) {
          const reason=matches.length>1?'存在同名项目':matches.length===0?'不存在':'不是可用的文件夹';
          throw new E('夸克目录第 '+(i+1)+' 级'+reason+'，请检查网盘目录后重试。');
        }
        id=matches[0].id;seen.add(id);
      }
      return id;
    }
    async ensureRoot() {
      if(this.root)return;
      const parent=await this.resolveParentID();
      let entry=unique(await this.rawList(parent),'zotero');
      if(!entry) {
        await this.api('/file','POST',{dir_init_lock:false,dir_path:'',file_name:'zotero',pdir_fid:parent});
        for(let i=0;i<7;i++) { entry=unique(await this.rawList(parent),'zotero');if(entry)break;await this.env.delay(500); }
      }
      if(!entry?.dir || !CloudCore.isQuarkFolderID(entry.id) || entry.id===parent)throw new E('夸克专用文件夹中没有可用的 zotero 子目录。');
      this.parentID=parent;this.root=entry.id;
    }
    async list() { await this.ensureRoot(); return this.rawList(this.root); }
    async get(name) {
      const f=await this.stat(name);if(!f||f.dir)throw new E('File not found',404);
      const j=await this.api('/file/download','POST',{fids:[f.id]});
      const link=j.data?.[0]?.download_url;if(!link)throw new E('夸克未返回下载地址。');
      const u=CloudCore.validateURL(link,'quark','download');
      const headers={Referer:'https://pan.quark.cn/','User-Agent':this.headers()['User-Agent']};
      if(u.hostname==='quark.cn'||u.hostname.endsWith('.quark.cn')) headers.Cookie=this.secrets.quarkCookie;
      const r=await this.env.request({provider:'quark',kind:'download',url:u.href,method:'GET',headers,maxBytes:this.config.maxMB*1048576,redirects:5});
      if(r.bytes.length!==f.size)throw new E('夸克下载文件大小校验失败。');
      return r.bytes;
    }
    async removeId(id) { await this.api('/file/delete','POST',{action_type:1,exclude_fids:[],filelist:[id]}); }
    async remove(name) {
      const f=await this.stat(name);if(!f)return;
      await this.removeId(f.id);await this.waitFor(name,v=>!v);
    }
    async rename(id,name) { await this.api('/file/rename','POST',{fid:id,file_name:name}); }
    async put(name,bytes) {
      await this.ensureRoot();
      const old=await this.stat(name), temp='cod-upload-'+this.env.random()+'.tmp';
      const uploaded=await this.upload(temp,bytes);
      let backup=null;
      try {
        if(old) { backup='cod-old-'+this.env.random()+'.tmp';await this.rename(old.id,backup);await this.waitFor(backup,f=>f?.id===old.id); }
        await this.rename(uploaded.id,name);
        const confirmed=await this.verifiedFile(name,bytes);
        if(confirmed.id!==uploaded.id)throw new E('夸克替换文件身份校验失败。');
      } catch(e) {
        if(backup) {
          try { if(!await this.stat(name))await this.rename(old.id,name); } catch(_){}
        }
        throw new E((e instanceof E?e.message+' ':'')+'夸克替换未完整确认；旧文件或临时文件保留在专用目录，请检查后重试。');
      }
      if(old) { await this.removeId(old.id);await this.waitFor(backup,f=>!f); }
    }
    async upload(name,bytes) {
      const now=Date.now(),mime='application/octet-stream';
      const pre=await this.api('/file/upload/pre','POST',{ccp_hash_update:true,dir_name:'',file_name:name,format_type:mime,l_created_at:now,l_updated_at:now,pdir_fid:this.root,size:bytes.length});
      const d=pre.data;if(!d?.task_id)throw new E('夸克预上传响应异常。');
      const hash=await this.api('/file/update/hash','POST',{md5:this.env.hash('md5',bytes),sha1:this.env.hash('sha1',bytes),task_id:d.task_id});
      if(!hash.data?.finish) {
        const size=Number(pre.metadata?.part_size);
        if(!Number.isSafeInteger(size)||size<1||size>64*1048576||!d.bucket||!d.obj_key||!d.upload_id||!d.upload_url)throw new E('夸克分片参数异常。');
        const endpoint=new URL(d.upload_url.startsWith('http')?d.upload_url:'https://'+d.upload_url);
        endpoint.protocol='https:';endpoint.hostname=d.bucket+'.'+endpoint.hostname;endpoint.pathname='/'+d.obj_key;endpoint.search='';
        CloudCore.validateURL(endpoint.href,'quark','upload');
        const agent='aliyun-sdk-js/6.6.1 Chrome 98.0.4758.80 on Windows 10 64-bit';
        const etags=[];
        for(let offset=0,part=1;offset<bytes.length;offset+=size,part++) {
          const chunk=bytes.subarray(offset,offset+size),date=new Date().toUTCString();
          const auth=await this.api('/file/upload/auth','POST',{auth_info:d.auth_info,auth_meta:'PUT\n\n'+mime+'\n'+date+'\nx-oss-date:'+date+'\nx-oss-user-agent:'+agent+'\n/'+d.bucket+'/'+d.obj_key+'?partNumber='+part+'&uploadId='+d.upload_id,task_id:d.task_id});
          if(!auth.data?.auth_key)throw new E('夸克分片授权缺失。');
          const r=await this.env.request({provider:'quark',kind:'upload',url:query(endpoint.href,{partNumber:part,uploadId:d.upload_id}),method:'PUT',headers:{Authorization:auth.data.auth_key,'Content-Type':mime,Referer:'https://pan.quark.cn/','x-oss-date':date,'x-oss-user-agent':agent},body:chunk});
          const etag=r.headers.etag;
          if(!etag||etag.replace(/"/g,'').toLowerCase()!==this.env.hash('md5',chunk))throw new E('夸克分片 ETag 校验失败。');
          etags.push(etag);
        }
        const body='<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n'+etags.map((e,i)=>'<Part><PartNumber>'+(i+1)+'</PartNumber><ETag>'+CloudCore.xml(e)+'</ETag></Part>\n').join('')+'</CompleteMultipartUpload>';
        const date=new Date().toUTCString(),md5=this.env.hash('md5',CloudCore.utf8(body),'base64'),callback=this.env.base64(CloudCore.utf8(JSON.stringify(d.callback)));
        const auth=await this.api('/file/upload/auth','POST',{auth_info:d.auth_info,auth_meta:'POST\n'+md5+'\napplication/xml\n'+date+'\nx-oss-callback:'+callback+'\nx-oss-date:'+date+'\nx-oss-user-agent:'+agent+'\n/'+d.bucket+'/'+d.obj_key+'?uploadId='+d.upload_id,task_id:d.task_id});
        if(!auth.data?.auth_key)throw new E('夸克合并授权缺失。');
        await this.env.request({provider:'quark',kind:'upload',url:query(endpoint.href,{uploadId:d.upload_id}),method:'POST',headers:{Authorization:auth.data.auth_key,'Content-MD5':md5,'Content-Type':'application/xml',Referer:'https://pan.quark.cn/','x-oss-callback':callback,'x-oss-date':date,'x-oss-user-agent':agent},body});
        await this.api('/file/upload/finish','POST',{obj_key:d.obj_key,task_id:d.task_id});
      }
      return this.verifiedFile(name,bytes);
    }
  }
  // Official Baidu Device Code OAuth. Web login Cookies are not API tokens.
  class BaiduQRLogin {
    constructor(config,secrets,env,cancel){this.config=config;this.secrets=secrets;this.env=env;this.cancel=cancel;}
    check(){if(this.cancel.cancelled)throw new E('百度扫码登录已取消。');}
    async wait(ms){
      this.check();
      await new Promise((resolve,reject)=>{
        let done=false;
        const finish=error=>{if(done)return;done=true;if(this.cancel.abort===abort)this.cancel.abort=null;error?reject(error):resolve();};
        const abort=()=>finish(new E('百度扫码登录已取消。'));this.cancel.abort=abort;
        Promise.resolve().then(()=>this.env.delay(ms)).then(()=>finish(),finish);
        if(this.cancel.cancelled)abort();
      });this.check();
    }
    async call(url){
      this.check();
      const r=await this.env.request({provider:'baidu',kind:'login',url,method:'GET',headers:{'User-Agent':'pan.baidu.com'},timeout:15000,cancel:this.cancel});
      this.check();
      try{return parseJSON(new TextDecoder().decode(r.bytes));}catch(_){throw new E('百度扫码授权接口响应异常，请重试。');}
    }
    oauthError(error){
      const messages={invalid_client:'百度应用信息不正确，请检查自己的 AppKey、SecretKey 和应用授权设置。',unauthorized_client:'该百度应用未获准使用设备码授权，请检查开放平台设置。',invalid_scope:'百度应用缺少 basic、netdisk 授权范围。',access_denied:'百度扫码授权已拒绝。',authorization_declined:'百度扫码授权已拒绝。',expired_token:'百度二维码已过期，请重新生成。',expired_device_code:'百度二维码已过期，请重新生成。',invalid_grant:'百度设备授权已失效，请重新生成二维码。'};
      return new E(messages[error]||'百度扫码授权失败，请检查应用权限并重试。');
    }
    async run(onQR){
      const client=this.config.baiduClient,secret=this.secrets.baiduSecret;
      if(typeof client!=='string'||!client.trim()||typeof secret!=='string'||!secret.trim())throw new E('百度扫码需要你自己的 AppKey 和 SecretKey，请先填写；不需要手动复制 Cookie 或 Token。');
      try{
        const device=await this.call(query('https://openapi.baidu.com/oauth/2.0/device/code',{response_type:'device_code',client_id:client,scope:'basic,netdisk'}));
        if(device?.error)throw this.oauthError(device.error);
        const code=device?.device_code,user=device?.user_code,expiry=Number(device?.expires_in),interval=Number(device?.interval??5);
        if(typeof code!=='string'||!code||code.length>4096||typeof user!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(user)||!Number.isFinite(expiry)||expiry<1||expiry>3600||!Number.isFinite(interval)||interval<0||interval>3600)throw new E('百度未返回有效的设备授权信息，请重试。');
        const deadline=Date.now()+expiry*1000;
        // Encode the documented first-party authorization URL locally. Never
        // load qrcode_url from an untrusted response as a remote image.
        onQR(query('https://openapi.baidu.com/device',{display:'mobile',code:user}),user);
        let gap=Math.max(5,interval)*1000;
        while(Date.now()<deadline){
          await this.wait(gap);if(Date.now()>=deadline)break;
          const token=await this.call(query('https://openapi.baidu.com/oauth/2.0/token',{grant_type:'device_token',code,client_id:client,client_secret:secret}));
          if(token?.error==='authorization_pending')continue;
          if(token?.error==='slow_down'){gap+=5000;continue;}
          if(token?.error)throw this.oauthError(token.error);
          if(typeof token?.access_token!=='string'||!token.access_token||typeof token?.refresh_token!=='string'||!token.refresh_token||/[\r\n]/.test(token.access_token+token.refresh_token))throw new E('百度未返回完整授权凭据；未替换已保存登录。');
          if(typeof token.scope==='string'&&!token.scope.split(/[ ,]+/).includes('netdisk'))throw new E('百度扫码未取得网盘授权；未替换已保存登录。');
          const info=await this.call(query('https://pan.baidu.com/rest/2.0/xpan/nas',{method:'uinfo',access_token:token.access_token}));
          if(Number(info?.errno||info?.error_code||0)!==0||!info?.uk)throw new E('百度扫码已确认，但网盘账号验证失败；未替换已保存登录。');
          this.check();return {baiduAccess:token.access_token,baiduRefresh:token.refresh_token};
        }
        throw new E('百度二维码已过期，请重新生成。');
      }finally{this.secrets={};}
    }
  }
  // Official Quark web QR flow; credentials never leave the first-party hosts.
  class QuarkQRLogin {
    constructor(env, cancel) {this.env=env;this.cancel=cancel;this.cookies=[];}
    check() {if(this.cancel.cancelled)throw new E('扫码登录已取消。');}
    absorb(url, values) {
      const host=new URL(url).hostname,now=Date.now();
      for(const raw of values||[]) {
        const parts=raw.split(';').map(x=>x.trim()),pair=parts.shift(),i=pair.indexOf('=');
        if(i<1)continue;
        const name=pair.slice(0,i),value=pair.slice(i+1),attrs={};
        if(!/^[A-Za-z0-9_-]+$/.test(name)||/[\r\n;]/.test(value))continue;
        for(const p of parts){const n=p.indexOf('=');attrs[(n<0?p:p.slice(0,n)).toLowerCase()]=n<0?'':p.slice(n+1);}
        const domain=(attrs.domain||host).replace(/^\./,'').toLowerCase();
        if(!(host===domain||host.endsWith('.'+domain))||!(domain==='quark.cn'||domain.endsWith('.quark.cn')))continue;
        const path=attrs.path?.startsWith('/')?attrs.path:'/',hostOnly=!attrs.domain;
        this.cookies=this.cookies.filter(c=>!(c.name===name&&c.domain===domain&&c.path===path));
        let expires=Infinity;
        if(attrs.expires&&Number.isFinite(Date.parse(attrs.expires)))expires=Date.parse(attrs.expires);
        if(attrs['max-age']!==undefined&&/^-?\d+$/.test(attrs['max-age']))expires=now+Number(attrs['max-age'])*1000;
        if(expires>now)this.cookies.push({name,value,domain,path,hostOnly,expires});
      }
    }
    cookie(url) {
      const u=new URL(url);
      return this.cookies.filter(c=>c.expires>Date.now()&&(u.hostname===c.domain||!c.hostOnly&&u.hostname.endsWith('.'+c.domain))&&(u.pathname===c.path||u.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/'))).sort((a,b)=>b.path.length-a.path.length).map(c=>c.name+'='+c.value).join('; ');
    }
    async call(url) {
      this.check();
      const headers={Referer:'https://pan.quark.cn/','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'};
      const cookie=this.cookie(url);if(cookie)headers.Cookie=cookie;
      const r=await this.env.request({provider:'quark',kind:'login',url,method:'GET',headers,timeout:15000,cancel:this.cancel});
      this.check();this.absorb(url,r.cookies);
      try{return parseJSON(new TextDecoder().decode(r.bytes));}catch(_){throw new E('夸克扫码接口响应异常，请重新尝试。');}
    }
    async run(onQR) {
      const base='https://uop.quark.cn/cas/ajax/';
      const uop=(path,params={})=>query(base+path,{client_id:532,v:'1.2',request_id:this.env.random(),...params});
      try {
        const first=await this.call(uop('getTokenForQrcodeLogin'));
        const token=first.data?.members?.token;
        if(Number(first.status)!==2000000||typeof token!=='string'||!token||token.length>4096)throw new E('夸克未返回有效二维码，请稍后重试。');
        onQR(query('https://su.quark.cn/4_eMHBJ',{token,client_id:532,ssb:'weblogin',uc_param_str:'',uc_biz_str:'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0'}));
        const deadline=Date.now()+180000;
        while(Date.now()<deadline) {
          await this.env.delay(2000);this.check();
          const result=await this.call(uop('getServiceTicketByQrcodeToken',{token}));
          const status=Number(result.status);
          if(status===50004001)continue;
          if(status===50004002)throw new E('二维码已过期，请点击“夸克扫码登录”重新生成。');
          const ticket=result.data?.members?.service_ticket;
          if(status!==2000000||typeof ticket!=='string'||!ticket)throw new E('夸克扫码未完成，请重新尝试。');
          const info=await this.call(query('https://pan.quark.cn/account/info',{st:ticket}));
          // Quark's business API uses code:"OK" as well as numeric zero.
          // Number("OK") is NaN and used to reject an otherwise valid login.
          const code=info?.code===undefined?info?.Status:info.code;
          if(info?.success!==true||![0,'0','OK'].includes(code)) {
            // Report only an explicit numeric error code, never msg or data:
            // these responses can contain account identifiers or credentials.
            const safeCode=typeof code==='number'&&Number.isSafeInteger(code)||typeof code==='string'&&/^-?\d{1,12}$/.test(code);
            throw new E('手机扫码已确认，但夸克登录凭据交换失败'+(safeCode?'（code='+code+'）':'')+'；未保存新的登录状态。');
          }
          // Read-only verification; do not create folders or touch attachments.
          const drive='https://drive-pc.quark.cn/1/clouddrive/file/sort';
          const files=await this.call(query(drive,{pr:'ucpro',fr:'pc',pdir_fid:'0',_page:1,_size:1,_sort:'file_type:asc,file_name:asc'}));
          if(Number(files.code||0)!==0||Number(files.status||200)>=400||!Array.isArray(files.data?.list))throw new E('扫码已确认，但网盘读取验证失败；未替换已保存凭据。');
          const cookie=this.cookie(drive);
          if(!/(?:^|;\s*)__(?:puus|pus)=([^;]+)/.test(cookie))throw new E('夸克未返回完整登录凭据；未替换已保存凭据。');
          this.check();return cookie;
        }
        throw new E('扫码等待超时，请重新生成二维码。');
      } finally {this.cookies=[];}
    }
  }
  return {Baidu,Quark,BaiduQRLogin,QuarkQRLogin,parseJSON,query,form,unique,create(config,secrets,env){return config.provider==='baidu'?new Baidu(config,secrets,env):new Quark(config,secrets,env);}};
})();
