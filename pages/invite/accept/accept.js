/**
 * pages/invite/accept · 邀请落地页（对齐设计稿：邀请页-01~06）
 *
 * - 正常态：宠物卡 + 大字邀请语 + 权限说明（✓/×）+ 成员预览条 + 沉底按钮
 * - 异常态统一模板：浅橙圆 + emoji + 标题 + 两行描述 + 按钮（文案全部对齐设计稿）
 * - 加入成功跳首页并切到该宠物
 */
const app = getApp()
const db = require('../../../utils/db')
const config = require('../../../utils/config')
const track = require('../../../utils/track')
const util = require('../../../utils/util')

Page({
  data: {
    status: 'loading',     // loading | ready | already | error
    pet: null,
    petName: '',
    petMeta: '',
    inviterName: '',
    memberCount: 0,
    mates: [],             // 成员预览（前3，{nickname, avatar}）
    mateNames: '',
    willBeNo: 1,           // 加入后是第 N 位成员
    joining: false,
    // 异常态
    errEmoji: '', errTitle: '', errDesc1: '', errDesc2: '', errBtn: '知道了'
  },

  onLoad(options) {
    // 卡片分享 path: pages/invite/accept/accept?inviteId=xxx；小程序码 scene: inviteId=xxx
    let inviteId = options.inviteId || ''
    if (!inviteId) {
      const scene = decodeURIComponent(options.scene || '')
      const m = /inviteId=([A-Za-z0-9]+)/.exec(scene)
      if (m) inviteId = m[1]
    }
    if (!inviteId) {
      this.setErr('error', { emoji: '🐾', title: '无法识别邀请', desc1: '邀请链接缺少必要信息', desc2: '请让邀请人重新发起邀请', btn: '知道了' })
      return
    }
    this._inviteId = inviteId
    app.ready(5000).then(() => this.preview())
  },

  // 预览邀请；五种异常态分别处理（设计稿 01~06）
  async preview() {
    try {
      const r = await db.previewInvite(this._inviteId)
      const pet = r.pet || {}
      const age = util.formatAge(pet.birthday, pet.adoptDay)
      const speciesName = (config.SPECIES.find((s) => s.key === pet.species) || {}).name || ''
      const members = r.members || []
      const names = members.map((m) => m.nickname).filter(Boolean)
      this.setData({
        status: 'ready',
        pet,
        petName: r.petName || pet.name || '这只宠物',
        petMeta: [pet.breed, age].filter(Boolean).join(' · '),
        inviterName: (r.inviter && r.inviter.nickname) || '你的家人',
        memberCount: r.memberCount || 1,
        mates: members.slice(0, 3),
        mateNames: names.slice(0, 2).join('、'),
        willBeNo: (r.memberCount || 1) + 1
      })
    } catch (e) {
      const reason = (e && e.result && e.result.reason) || ''
      const extra = e && e.result ? e.result : {}
      if (reason === 'already') {
        this._alreadyPetId = extra.petId || ''
        this.setErr('already', {
          emoji: '✅',
          title: '你已经在记录了',
          desc1: `你和另外 ${Math.max(0, (extra.memberCount || 1) - 1)} 个人一起记录 ${extra.petName || '这只宠物'}`,
          desc2: '直接打开就能看到最新进展',
          btn: '去看看'
        })
        return
      }
      this.applyReason(reason, extra)
    }
  },

  // 接受邀请
  async onJoin() {
    if (this.data.joining) return
    this.setData({ joining: true })
    try {
      const r = await db.acceptInvite(this._inviteId)
      track.track('invite_accepted', { petId: r.petId, isNewUser: true })
      wx.showToast({ title: '加入成功', icon: 'success' })
      const store = require('../../../utils/store')
      db.invalidateAll()
      store.setCurrentPet(r.petId)
      setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 400)
    } catch (e) {
      const reason = (e && e.result && e.result.reason) || ''
      if (reason === 'already') {
        this._alreadyPetId = (e.result && e.result.petId) || ''
        this.setErr('already', {
          emoji: '✅',
          title: '你已经在记录了',
          desc1: `你和另外 0 个人一起记录 ${(e.result && e.result.petName) || '这只宠物'}`,
          desc2: '直接打开就能看到最新进展',
          btn: '去看看'
        })
      } else if (reason) {
        this.applyReason(reason, (e && e.result) || {})
      } else {
        util.toast('加入失败')
        this.setData({ joining: false })
      }
      track.track('invite_failed', { reason: reason || 'error' })
    }
  },

  onSkip() { wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }) },

  // 异常态按钮：知道了 → 返回；去看看 → 进首页并切宠物
  onErrBtn() {
    if (this.data.status === 'already') {
      const store = require('../../../utils/store')
      db.invalidateAll()
      store.setCurrentPet(this._alreadyPetId)
      wx.switchTab({ url: '/pages/home/home' })
      return
    }
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) })
  },

  // 设计稿 02~05 异常态文案
  applyReason(reason, extra) {
    const petName = (extra && extra.petName) || ''
    const map = {
      expired: { emoji: '⌛', title: '邀请已过期', desc1: '这个邀请发出超过 7 天了', desc2: '让 TA 重新邀请你一次就好', btn: '知道了' },
      revoked: { emoji: '↩️', title: '这个邀请已被取消', desc1: '对方撤销了这次邀请', desc2: '如果你想加入，可以让 TA 再邀请一次', btn: '知道了' },
      used: { emoji: '🐾', title: '这个邀请已经用过了', desc1: '每次邀请只能用一次', desc2: '让 TA 再给你发一个新的邀请', btn: '知道了' },
      full: { emoji: '👥', title: `${petName || '这只宠物'}已经有 5 个人在记录了`, desc1: '一只宠物最多 5 人一起记', desc2: '需要有人退出后才能再加入', btn: '知道了' }
    }
    const item = map[reason]
    if (item) {
      this.setErr('error', item)
    } else {
      this.setErr('error', { emoji: '🐾', title: '无法识别邀请', desc1: String((extra && extra.errMsg) || '请稍后重试').slice(0, 40), desc2: '', btn: '知道了' })
    }
  },

  setErr(status, o) {
    this.setData({
      status,
      errEmoji: o.emoji, errTitle: o.title,
      errDesc1: o.desc1 || '', errDesc2: o.desc2 || '', errBtn: o.btn || '知道了',
      petName: this.data.petName || o.petName || ''
    })
  }
})