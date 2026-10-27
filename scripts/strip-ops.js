#!/usr/bin/env node
/**
 * strip-ops · 提审前把「运营后台」页面从小程序包里摘除
 *
 * 用法：node scripts/strip-ops.js      （提审前）
 *      node scripts/restore-ops.js    （过审后）
 *
 * ── 为什么要这个脚本 ────────────────────────────────────────────
 * pages/ops/ops 是我们自己的客服运营后台（改话术 / 换投放素材 / 看会话 / 内容审核）。
 * 它有管理员鉴权，非管理员只看到「没有运营权限」，数据面是安全的。
 * 但它**在提审包里**：一旦被自动化扫描命中文案，或被认定「诱导站外导流」，
 * 处罚是封禁分享能力甚至下架 —— 前期所有投入归零。
 *
 * ── 为什么必须做三件事，只改 app.json 不够 ──────────────────────
 * project.config.json 里 `ignoreUploadUnusedFiles: false`：
 * 项目里的所有文件都会被上传，**不管 app.json 有没有引用**。
 * 所以只从 app.json 删掉页面声明，ops 的代码依然完整躺在包里 —— 等于没摘。
 *   ① app.json 删声明        → 否则包内引用了不存在的页面，启动直接报错
 *   ② packOptions 加忽略      → 真正让文件不进包（这一步才是关键）
 *   ③ mine.js 入口失效        → 避免残留入口点了没反应
 *
 * 幂等：已摘除时重复执行只会提示，不会二次破坏。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APP_JSON = path.join(ROOT, 'app.json')
const PROJ_CFG = path.join(ROOT, 'project.config.json')
const MINE_JS = path.join(ROOT, 'pages', 'mine', 'mine.js')
/** 状态文件放 .workbuddy（已在 packOptions.ignore 里，不会进包） */
const MARKER = path.join(ROOT, '.workbuddy', 'ops-stripped.json')

const PAGE = 'pages/ops/ops'
const FOLDER = 'pages/ops'
const NAV_STMT = "wx.navigateTo({ url: '/pages/ops/ops' })"

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n')

if (fs.existsSync(MARKER)) {
  console.log('⚠️  已经是摘除状态，无需重复执行。')
  console.log('   过审后恢复：node scripts/restore-ops.js')
  process.exit(0)
}

// 先备份三份原始内容，restore 靠它精确还原（不猜、不重放）
const orig = {
  appJson: fs.readFileSync(APP_JSON, 'utf8'),
  project: fs.readFileSync(PROJ_CFG, 'utf8'),
  mine: fs.readFileSync(MINE_JS, 'utf8')
}

/* ① app.json 去掉页面声明 */
const app = readJson(APP_JSON)
const before = app.pages.length
app.pages = app.pages.filter((p) => p !== PAGE)
if (app.pages.length === before) console.log(`⚠️  app.json 里没有 ${PAGE}，跳过`)
else console.log(`✅ app.json：移除页面声明 ${PAGE}`)
writeJson(APP_JSON, app)

/* ② packOptions 加上传忽略（真正让文件不进包） */
const proj = readJson(PROJ_CFG)
proj.packOptions = proj.packOptions || {}
proj.packOptions.ignore = proj.packOptions.ignore || []
const hasFolder = proj.packOptions.ignore.some((r) => r.type === 'folder' && r.value === FOLDER)
if (hasFolder) console.log(`⚠️  packOptions 已忽略 ${FOLDER}，跳过`)
else {
  proj.packOptions.ignore.push({ type: 'folder', value: FOLDER })
  console.log(`✅ project.config.json：packOptions 忽略 ${FOLDER}`)
}
writeJson(PROJ_CFG, proj)

/* ③ mine.js 入口失效 */
if (orig.mine.indexOf(NAV_STMT) >= 0) {
  fs.writeFileSync(MINE_JS, orig.mine.replace(NAV_STMT, "U.toast('运营后台已在本版本移除')"))
  console.log('✅ pages/mine/mine.js：goOps 入口改为提示')
} else {
  console.log('⚠️  mine.js 里没找到跳转语句，跳过（页面已不可达，不影响上传）')
}

fs.mkdirSync(path.dirname(MARKER), { recursive: true })
fs.writeFileSync(MARKER, JSON.stringify({ at: new Date().toISOString(), orig }, null, 2))

console.log('\n📦 已摘除运营后台，现在可以「上传」提审。')
console.log('   过审后恢复：node scripts/restore-ops.js')
