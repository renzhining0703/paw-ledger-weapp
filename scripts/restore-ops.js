#!/usr/bin/env node
/**
 * restore-ops · 过审后把「运营后台」页面恢复回来
 *
 * 用法：node scripts/restore-ops.js
 *
 * 从 strip-ops.js 留下的备份里精确还原三份文件（app.json / project.config.json / mine.js），
 * 不做「反向推断」—— 推断式还原最容易把后来手动改过的配置冲掉。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MARKER = path.join(ROOT, '.workbuddy', 'ops-stripped.json')

if (!fs.existsSync(MARKER)) {
  console.log('⚠️  当前不在摘除状态（没有 .workbuddy/ops-stripped.json），无需恢复。')
  process.exit(0)
}

const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
const o = m.orig || {}

if (!o.appJson || !o.project || !o.mine) {
  console.error('❌ 备份文件不完整，已中止，未改动任何文件。')
  console.error('   手动检查：app.json 是否含 pages/ops/ops、project.config.json 的 packOptions')
  process.exit(1)
}

fs.writeFileSync(path.join(ROOT, 'app.json'), o.appJson)
fs.writeFileSync(path.join(ROOT, 'project.config.json'), o.project)
fs.writeFileSync(path.join(ROOT, 'pages', 'mine', 'mine.js'), o.mine)
fs.unlinkSync(MARKER)

console.log('✅ 已恢复运营后台：')
console.log('   · app.json 重新声明 pages/ops/ops')
console.log('   · project.config.json 移除 pages/ops 忽略项')
console.log('   · pages/mine/mine.js 恢复 goOps 跳转')
console.log(`   （本次摘除发生在 ${m.at}）`)
