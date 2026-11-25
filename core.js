/* SPDX-License-Identifier: AGPL-3.0-or-later */
var CloudCore = (() => {
  class CloudError extends Error {
    constructor(message, status = 502) { super(message); this.name = 'CloudError'; this.status = status; }
  }
  const utf8 = s => new TextEncoder().encode(s);
  const xml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const suffix = (host, domain) => host === domain || host.endsWith('.' + domain);
  function requestStage(options) {
    const provider=options.provider==='quark'?'夸克':'百度';
    const u=new URL(options.url);
    if(options.kind==='login')return provider+'：'+({'/oauth/2.0/device/code':'生成授权二维码','/oauth/2.0/token':'等待扫码授权','/rest/2.0/xpan/nas':'验证扫码账号','/cas/ajax/getTokenForQrcodeLogin':'生成登录二维码','/cas/ajax/getServiceTicketByQrcodeToken':'等待扫码确认','/account/info':'完成扫码授权','/1/clouddrive/file/sort':'验证扫码登录'}[u.pathname]||'扫码登录');
    if(options.kind==='download')return provider+'：下载文件';
    if(options.kind==='upload')return provider+(options.method==='POST'&&options.provider==='quark'?'：合并上传分片':'：上传文件分片');
    if(options.provider==='quark'){
      const stages={'/config':'登录状态检查','/file/sort':'读取目录','/file':'创建同步目录','/file/download':'获取下载地址','/file/delete':'删除测试或旧文件','/file/rename':'替换文件名','/file/upload/pre':'预上传','/file/update/hash':'提交文件校验值','/file/upload/auth':'申请上传签名','/file/upload/finish':'确认上传完成'};
      return provider+'：'+(stages[u.pathname.replace('/1/clouddrive','')]||'接口请求');
    }
    return provider+'：'+({'list':'读取目录','uinfo':'登录状态检查','precreate':'预上传','create':'提交文件','filemetas':'获取下载地址','filemanager':'管理文件'}[u.searchParams.get('method')]||(u.hostname==='openapi.baidu.com'?'官方授权':'接口请求'));
  }
  function httpFailure(options,status,bytes) {
    const stage=requestStage(options),codes=[];
    try{
      const body=new TextDecoder().decode(bytes||new Uint8Array());
      if(body.length<=65536){
        try{const j=JSON.parse(body);for(const key of ['code','errno','error_code','status']){const v=j?.[key];if(typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='string'&&/^-?\d{1,12}$/.test(v))codes.push(key+'='+v);}}catch(_){}
        const code=body.match(/<Code>([A-Za-z]+)<\/Code>/)?.[1];
        if(['SignatureDoesNotMatch','AccessDenied','InvalidAccessKeyId','RequestTimeTooSkewed','InvalidArgument','InvalidPart','InvalidPartOrder','NoSuchUpload','CallbackFailed','InternalError','ServiceUnavailable'].includes(code))codes.push('OSS='+code);
      }
    }catch(_){}
    const error=new CloudError(stage+'失败：HTTP '+status+(codes.length?'（'+codes.join('，')+'）':'')+'。');
    error.httpStatus=status;error.stage=stage;return error;
  }
  function validateURL(value, provider, kind = 'api') {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) {
      throw new CloudError('拒绝不安全的网盘地址。');
    }
    if(kind==='login') {
      if(provider==='baidu'){
        if(u.hostname==='openapi.baidu.com'&&['/oauth/2.0/device/code','/oauth/2.0/token'].includes(u.pathname))return u;
        if(u.hostname==='pan.baidu.com'&&u.pathname==='/rest/2.0/xpan/nas'&&u.searchParams.get('method')==='uinfo')return u;
        throw new CloudError('拒绝未允许的百度扫码授权地址。');
      }
      const paths={'uop.quark.cn':['/cas/ajax/getTokenForQrcodeLogin','/cas/ajax/getServiceTicketByQrcodeToken'],'pan.quark.cn':['/account/info'],'drive-pc.quark.cn':['/1/clouddrive/file/sort']};
      if(provider!=='quark'||!paths[u.hostname]?.includes(u.pathname))throw new CloudError('拒绝未允许的扫码登录地址。');
      return u;
    }
    const domains = provider === 'baidu'
      ? (kind === 'api' ? ['pan.baidu.com', 'openapi.baidu.com', 'd.pcs.baidu.com'] : ['baidu.com','baidupcs.com','baidupcs.cn','bcebos.com'])
      : (kind === 'api' ? ['drive-pc.quark.cn'] : ['quark.cn','aliyuncs.com']);
    if (!domains.some(d => suffix(u.hostname, d))) throw new CloudError('网盘返回了未允许的服务域名，已停止连接。');
    return u;
  }
  const isQuarkFolderID = id => typeof id === 'string' && /^[A-Za-z0-9_-]{2,128}$/.test(id);
  function quarkPathParts(path) {
    const parts = typeof path === 'string' && path.startsWith('/') && path.length <= 800 ? path.slice(1).split('/') : [];
    if (!parts.length || parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f\x7f?#]/.test(part))) {
      throw new CloudError('请填写夸克专用目录的完整路径，例如 /文献/Zotero。不能使用根目录、空路径段或末尾的 /。', 400);
    }
    return parts;
  }
  function validateConfig(config) {
    if (!['baidu','quark'].includes(config.provider)) throw new CloudError('请选择百度或夸克。', 400);
    const max = Number(config.maxMB);
    if (!Number.isInteger(max) || max < 1 || max > 256) throw new CloudError('附件包大小上限应为 1–256 MiB。', 400);
    if (config.provider === 'quark' && (config.quarkPath || !isQuarkFolderID(config.quarkFolder))) {
      quarkPathParts(config.quarkPath);
    }
    if (config.provider === 'baidu') {
      const p = config.baiduFolder || '';
      if (!p.startsWith('/') || p === '/' || p.length > 800 || /[\\\x00-\x1f?#]/.test(p) || p.split('/').some(x => x === '.' || x === '..') || p.endsWith('/')) {
        throw new CloudError('请填写百度专用目录的绝对路径，且不要以 / 结尾。', 400);
      }
    }
    return config;
  }
  function safeName(name) {
    return /^(?:[A-Z0-9]{8}\.(?:zip|prop)|zotero-test-file\.prop|nonexistent\.prop|lastsync(?:\.txt)?|cod-test-[a-f0-9-]+\.prop)$/.test(name);
  }
  function parsePath(raw, prefix) {
    if (!raw.startsWith(prefix)) throw new CloudError('Not found', 404);
    let part;
    try { part = decodeURIComponent(raw.slice(prefix.length)); } catch (_) { throw new CloudError('Bad path', 400); }
    if (part === '') return { type:'parent' };
    if (part === 'zotero' || part === 'zotero/') return { type:'root' };
    if (!part.startsWith('zotero/') || !safeName(part.slice(7))) throw new CloudError('Not found', 404);
    return { type:'file', name:part.slice(7) };
  }
  function multistatus(entries) {
    return utf8('<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:">' + entries.map(e =>
      '<D:response><D:href>' + xml(e.href) + '</D:href><D:propstat><D:prop>' +
      '<D:resourcetype>' + (e.dir ? '<D:collection/>' : '') + '</D:resourcetype>' +
      '<D:getcontentlength>' + (e.size || 0) + '</D:getcontentlength>' +
      '<D:getlastmodified>' + xml(new Date(e.modified || Date.now()).toUTCString()) + '</D:getlastmodified>' +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    ).join('') + '</D:multistatus>');
  }
  class DAV {
    constructor(provider, { prefix, authorization, maxBytes }) {
      this.provider = provider; this.prefix = prefix; this.authorization = authorization; this.maxBytes = maxBytes;
      this.tail = Promise.resolve(); this.stopping = false; this.failure = null; this.operations = 0;
    }
    handle(req) {
      if (this.stopping) return Promise.resolve({status:503});
      const p = this.tail.then(() => this._handle(req)).catch(e => {
        if (!(e instanceof CloudError) || e.status >= 500) this.failure = e instanceof CloudError ? e : new CloudError('网盘操作失败，未确认同步完成。');
        return {status:e instanceof CloudError ? e.status : 502, body:utf8(e instanceof CloudError ? e.message : 'Cloud operation failed')};
      });
      this.tail = p.then(() => {}); return p;
    }
    async drain() { this.stopping = true; await this.tail; }
    async _handle(req) {
      const headers = req.headers || {};
      if (headers.authorization !== this.authorization) return { status:401, headers:{'WWW-Authenticate':'Basic realm="CloudOnDemand"'} };
      if (headers.origin) throw new CloudError('Browser origin denied',403);
      const p = parsePath(req.path, this.prefix);
      const method = req.method.toUpperCase();
      const allow = 'OPTIONS, PROPFIND, HEAD, GET, PUT, DELETE, MKCOL';
      if (method === 'OPTIONS') return { status:200, headers:{DAV:'1',Allow:allow} };
      if (method === 'MKCOL') {
        if (p.type !== 'root') throw new CloudError('Collection change denied',403);
        await this.provider.ensureRoot(); return { status:201 };
      }
      await this.provider.ensureRoot();
      if (method === 'PROPFIND') {
        const depth = String(headers.depth ?? '0');
        if (!['0','1'].includes(depth)) throw new CloudError('Only Depth 0 or 1 is supported',403);
        let entries = [];
        if (p.type === 'file') {
          const f = await this.provider.stat(p.name); if (!f) return {status:404};
          entries.push({...f,href:this.prefix+'zotero/'+encodeURIComponent(p.name)});
        } else {
          entries.push({href:this.prefix+(p.type==='root'?'zotero/':''),dir:true});
          if (depth === '1') {
            if (p.type === 'parent') entries.push({href:this.prefix+'zotero/',dir:true});
            else entries.push(...(await this.provider.list()).filter(f => safeName(f.name) && !f.dir).map(f => ({...f,href:this.prefix+'zotero/'+encodeURIComponent(f.name)})));
          }
        }
        return {status:207,headers:{'Content-Type':'application/xml; charset=utf-8'},body:multistatus(entries)};
      }
      if (p.type !== 'file') return {status:method==='DELETE'?403:405};
      if (method === 'PUT') {
        const bytes = req.body || new Uint8Array();
        if (bytes.length > this.maxBytes) return {status:413};
        if (!bytes.length) throw new CloudError('Empty files are not supported',400);
        await this.provider.put(p.name, bytes); this.operations++; return {status:204};
      }
      const f = await this.provider.stat(p.name);
      if (!f) return {status:404};
      if (f.dir) return {status:403};
      if (method === 'DELETE') { await this.provider.remove(p.name); this.operations++; return {status:204}; }
      if (method === 'HEAD' || method === 'GET') {
        if (f.size > this.maxBytes) return {status:413};
        const out = {status:200,headers:{'Content-Type':'application/octet-stream','Content-Length':String(f.size),'Last-Modified':new Date(f.modified || Date.now()).toUTCString()}};
        if (method === 'GET') { out.body = await this.provider.get(p.name); if (out.body.length > this.maxBytes) return {status:413}; out.headers['Content-Length'] = String(out.body.length); }
        return out;
      }
      return {status:405,headers:{Allow:allow}};
    }
  }
  return {CloudError,utf8,xml,requestStage,httpFailure,validateURL,validateConfig,quarkPathParts,isQuarkFolderID,safeName,parsePath,multistatus,DAV};
})();
