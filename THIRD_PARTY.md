# 协议参考与许可

本原型以 AGPL-3.0-or-later 发布。实现网盘协议时参考了以下源码的请求字段、端点和上传步骤；未捆绑或运行 OpenList 二进制程序。

- OpenListTeam/OpenList，drivers/baidu_netdisk/driver.go、util.go：百度 OAuth、目录列表、下载、预上传、分片上传、文件提交与删除。项目地址：https://github.com/OpenListTeam/OpenList
- OpenListTeam/OpenList，drivers/quark_uc/driver.go、util.go、types.go：夸克请求字段、Cookie、OSS 分片签名、上传合并、完成与文件操作。相同项目，AGPL-3.0 系列许可；相应请求格式适配在 providers.js。
- Zotero 官方插件示例 make-it-red：bootstrap 生命周期和 manifest 结构参考。https://github.com/zotero/make-it-red
- 本机 Zotero 10.0.8 的 WebDAV / Sync Runner / Storage Local / HTTP server 接口用于兼容性研究；未把其实现源码复制进发布包。项目：https://github.com/zotero/zotero

完整 AGPL v3 许可文本见 LICENSE（标准许可文本，取自先前下载的 ZoteroBaidupanSync 仓库 LICENSE）。本原型不包含该百度插件的业务代码。

研究过程中下载的原始参考源码保留在工作目录，未打入 XPI 安装包。API 行为仍需真实账户验证。

## 0.1.6 扫码登录

- 夸克协议字段参考 2026-11-19 从官方 https://pan.quark.cn/ 加载的 https://g.alicdn.com/quark-cloud-drive/quark-cloud-drive-static-page/0.1.78/js/index.js；仅研究端点和状态机，未复制或捆绑该官方脚本。研究快照保留在 work/login-research/。
- qrcode.js：QR Code Generator for JavaScript，Copyright (c) 2009 Kazuhiko Arase，MIT。来自 https://github.com/kazuhikoarase/qrcode-generator 的 js/dist/qrcode.js，2026-11-19 下载；原始版权头完整保留，完整 MIT 许可文本见随包 QR_LICENSE.txt。该文件只负责本地编码，不发起网络请求。

## 0.2.0 百度设备码授权

- 百度网盘开放平台《设备码模式授权》，https://pan.baidu.com/union/doc/使用入门/接入授权/设备码模式授权/，2026-11-19 查阅。参考设备码、用户码、二维码 URL、device_token 轮询、最低轮询间隔及 Refresh Token 的一次性轮换要求。仅调用百度官方 openapi.baidu.com 与 pan.baidu.com API，没有复制或捆绑百度 SDK。
