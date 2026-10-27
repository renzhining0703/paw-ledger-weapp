/**
 * 邀请转发内容统一构建（4 个入口共用：宠物列表 / 档案详情 / 成员管理 / 档案编辑）
 *
 * 返回 { title, path, imageUrl }：
 * - title：`{邀请人} 邀请你一起记录 {宠物名}`（无昵称则省略邀请人）
 * - path：邀请落地页（携带 inviteId）
 * - imageUrl：invite-card 生成的 5:4 卡面图；生成失败回落宠物头像；再失败不传（用页面默认截图）
 *
 * 注：微信分享了「标题 + 图 + 落地页」三项可定制，其余由微信渲染，所以设计稿卡面只能做成图。
 */
const db = require('./db')
const store = require('./store')
const track = require('./track')
const U = require('./util')

/**
 * @param {object} page 页面实例（用于 selectComponent 找离屏 canvas）
 * @param {object} pet 宠物档案
 * @param {string} channel 埋点渠道：list | profile | card
 */
async function build(page, pet, channel) {
  const petId = pet && pet._id
  const petName = (pet && pet.name) || '这只宠物'
  const inviter = ((store.getUser() || {}).nickname || '').trim()

  // 宠物还没落到 store（深链/新建态）时直接给默认分享，别让云函数兜错
  if (!petId) return { title: petName, path: '/pages/home/home' }

  try {
    const r = await db.createInvite(petId)
    // 30s 内的重复点击会复用同一条邀请（去抖），复用不计一次「新建邀请」，避免埋点虚高
    if (!r.reused) track.track('invite_created', { petId, channel })
    const imageUrl = await cardImage(page, pet, inviter)
    return {
      title: inviter ? `${inviter} 邀请你一起记录 ${petName}` : `邀请你一起记录 ${petName}`,
      path: `/pages/invite/accept/accept?inviteId=${r.inviteId}`,
      imageUrl: imageUrl || undefined
    }
  } catch (e) {
    const reason = e && e.errCode === 101 ? '成员已满' : '生成邀请失败'
    if (e && e.errCode === 101) track.track('invite_failed', { reason: 'full' })
    else track.track('invite_failed', { reason: 'create_error' })
    U.toast(reason)
    // 兜底：不带 inviteId，避免分享出打不开的链接
    return { title: petName, path: '/pages/home/home' }
  }
}

/** 卡面图：canvas 生成 → 宠物头像 → '' */
async function cardImage(page, pet, inviter) {
  try {
    const comp = page && typeof page.selectComponent === 'function' && page.selectComponent('#inviteCard')
    if (comp && typeof comp.generate === 'function') {
      const p = await comp.generate({ pet, inviterName: inviter })
      if (p) return p
    }
  } catch (e) {
    console.warn('[invite-share] 卡面生成失败，回落头像', e)
  }
  try {
    return await U.petShareImage(pet)
  } catch (e) {
    return ''
  }
}

module.exports = { build }
