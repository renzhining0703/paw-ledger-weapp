# 它的时光 · 宠物记录小程序

轻量宠物成长记录工具：宠物档案、疫苗 / 驱虫 / 体检到期提醒、成长时间线图文、按月归档相册、养宠花销记账、亲友团共享记录。

- 技术栈：原生小程序（WXML / WXSS / JS）+ 微信云开发（云函数 + 云数据库 + 云存储）
- AppID：`wx7326e353b2996845`
- 4 个 tab：首页 / 健康 / 时光 / 我的（记账为二级页）

## 目录结构

```
├── app.js / app.json / app.wxss    入口（静默登录 / 路由 / 设计令牌）
├── pages/
│   ├── home/            首页：倒计时卡、随手记、时间线预览、空态
│   ├── health/          健康：疫苗 / 驱虫（体内·体外）/ 体检 分类切换
│   ├── timeline/        时光：时间线 + 相册（分段切换、筛选、分组）
│   ├── mine/            我的：头像昵称、授权余额、同步状态、设置入口
│   ├── ledger/          记账（二级页）：月统计 + 分类占比 + 流水
│   ├── pet/             宠物档案：list / edit / profile / members
│   ├── invite/accept/   邀请接受页
│   ├── settings/        设置：同步状态、清理缓存、协议、反馈、关于
│   ├── agreement/       用户协议 / 隐私政策（正文见 utils/agreements.js）
│   ├── feedback/        帮助与反馈
│   ├── about/           关于我们
│   └── ops/             运营后台（仅管理员可见；提审前须摘除，见文末）
├── components/          18 个通用组件
│                       bottom-sheet / ui-dialog / skeleton / empty-state（基础）
│                       pet-avatar / pet-switcher / avatar-cropper（头像与切换）
│                       record-sheet / daily-sheet / daily-picker / post-sheet（录入）
│                       timeline-item / album-grid / share-pop（时间线与分享）
│                       agreement-gate / invite-card / recommend-card / quick-ball
├── utils/
│   ├── config.js        全局配置（环境 / 模板 / 物种 / 分类 / 周期 / 协议版本）
│   ├── db.js            数据层：缓存 + 弱网写队列 + 待同步角标
│   ├── media.js         图片管线：选图 → 落盘 → 双档压缩 → 上传
│   ├── timeline.js      多集合归并 + 里程碑混入 + 分页分组
│   ├── store.js         全局状态 + 事件总线
│   ├── track.js         埋点：队列 + 批量上报 + 退避重试
│   ├── agreements.js    协议全文（唯一数据源）
│   ├── milestones.js    档案派生里程碑（不落库）
│   ├── cs.js            客服触点（session-from 归因）
│   ├── util.js          日期（中国时区）/ 金额（分）/ 最大余数法
│   └── invite-share.js  邀请分享
├── cloudfunctions/
│   ├── login/           静默登录（返回 openid）
│   ├── petData/         宠物数据统一读写入口（权限收口 + 内容安全）
│   ├── petRemove/       删除宠物：级联删记录与云文件
│   ├── remind/          每日 09:00 扫描到期 → 订阅消息推送
│   ├── subscribe/       授权成功余额 +1
│   ├── customer/        客服消息推送接收（自动回复 + 素材下发）
│   ├── csSend/          待发队列定时投递（每分钟）
│   ├── csAdmin/         运营后台数据读写（口令 + openid 白名单）
│   ├── secScan/         内容安全巡检（每 30 分钟）
│   ├── statDaily/       日活/漏斗日聚合（每天 01:10 落库 dailyStats，可传 date 补算）
│   └── track/           埋点落库 + 每月清理
├── scripts/             提审摘除 / 恢复运营后台（strip-ops.js / restore-ops.js）
└── assets/              tabbar 图标 / 物种与日常图标 / 空态插画 / Logo
```

## 跑起来需要什么

1. `utils/config.js` → 填 `CLOUD_ENV`（云开发环境 ID）与 `SUBSCRIBE_TEMPLATE_ID`（订阅消息模板）
2. `cloudfunctions/remind/index.js` → `TEMPLATE_ID` 与上一处保持一致
3. 云函数环境变量 `MINI_APPID`、`MINI_APPSECRET`：`remind` / `customer` / `csSend` / `csAdmin` 各配一份
4. 建云数据库集合
   - **仅创建者可读写**：`pets` `health` `weights` `daily` `expenses` `users` `subTickets` `events`
   - **所有用户不可读写**（云函数收口）：`posts` `petMembers` `invites` `csSessions` `csQuota` `csOutbox` `csConfig` `csMessages` `banned` `reports` `auditWhitelist` `rateLimit` `adminLog` `dailyStats`
5. 建索引：`events.eventId`（唯一）、`events.serverTs`（降序，数据看板按时间区间聚合用）、`posts` 的 `petId + createdAt`、`health/weights/daily/expenses` 的 `petId + date`
6. 上传并部署 `cloudfunctions/` 下全部目录（`statDaily` 的 `config.json` 自带每天 01:10 的定时触发器，随部署自动创建）
7. mp 后台 → 用户隐私保护指引：勾选「选中的照片或视频信息」「相册（仅写入）」「微信昵称、头像」「剪切板」

> 建集合这条最容易漏：云开发不会自动建表，漏了的表现是**写入静默失败、界面却看着正常**。
> 剪切板同理 —— 没声明时复制按钮 `fail`，表现为「点了没反应」。

## 提审前

运营后台 `pages/ops/ops` 在提审包里，一旦被认定「诱导站外导流」，处罚是封禁分享能力甚至下架。提审前必须摘除：

```bash
node scripts/strip-ops.js     # 提审前
node scripts/restore-ops.js   # 过审后
```

⚠️ 只从 `app.json` 删页面声明**没用** —— 本工程 `ignoreUploadUnusedFiles: false`，项目里所有文件都会被上传。脚本会同时加 `packOptions.ignore`（幂等，重复跑只会提示）。
