/**
 * pages/pet/members · 成员管理页（PRD 5.3，样式对齐「成员页-01/02/03」设计图）
 *
 * - owner：可移除成员、撤销邀请、邀请他人
 * - member：可邀请他人、退出共享、关自己的 notify；不能移除任何人
 * - 顶部：宠物卡 + 邀请进度条（还可邀请 N 人 / 已满员）
 * - 「由 XX 邀请」：优先读落库快照 invitedByName/inviterName，旧数据回落成员昵称映射
 */
const app = getApp()
const db = require('../../../utils/db')
const config = require('../../../utils/config')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const util = require('../../../utils/util')
const inviteShare = require('../../../utils/invite-share')

/** 云函数返回的 Date 字段经 callFunction 序列化后不再是 Date 实例，统一兼容转换（北京时间口径） */
function tsToYMD(ts) {
  const d = new Date(ts + 8 * 3600 * 1000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
}

/** 时间戳 -> 'MM-DD HH:mm'（邀请生成时刻展示用） */
function tsToMDHM(ts) {
  const d = new Date(ts + 8 * 3600 * 1000)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** 各种序列化形态 -> 时间戳；无法解析返回 null */
function toTs(v) {
  if (!v) return null
  if (typeof v === 'object') {
    if (typeof v.getTime === 'function') return v.getTime()
    if (v.$date != null) return v.$date
    return null
  }
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d.getTime()
  }
  return null
}

function fmtCloudDate(v) {
  const ts = toTs(v)
  if (ts == null) return typeof v === 'string' ? v.slice(0, 10) : ''
  return tsToYMD(ts)
}

function fmtCloudDateTime(v) {
  const ts = toTs(v)
  return ts == null ? '' : tsToMDHM(ts)
}

Page({
  data: {
    petId: '',
    pet: null,
    petInfo: '',
    members: [],
    memberCount: 0,
    maxMembers: config.MAX_MEMBERS,
    myRole: 'member',
    myOpenid: '',
    myNotify: true,
    isFull: false,
    // 进度条（rpx 直接用百分比宽度）
    barPct: 0,
    barLabel: '',
    pending: [],
    hasUnlabeled: false,
    invitedByNames: {}
  },

  onLoad(options) {
    this.setData({ petId: options.petId || '' })
    app.ready(5000).then(() => this.load())
  },

  onShow() {
    if (this._loaded) this.load()
  },

  async load() {
    const petId = this.data.petId
    if (!petId) return
    try {
      // 成员列表是主数据；待接受邀请失败只降级为空，不拖垮整页
      const mRes = await db.listMembers(petId)
      const pRes = await db.listPendingInvites(petId).catch(() => null)
      const members = (mRes && mRes.data) || []
      const pending = (pRes && pRes.data) || []
      const myOpenid = (mRes && mRes.myOpenid) || ''

      // 构造 invitedBy 昵称映射（旧数据无落库快照时兜底）：invitedBy openid → 成员 nickname
      const nameMap = {}
      members.forEach((m) => {
        if (m.nickname) nameMap[m._openid] = m.nickname
      })

      // 行副标题：owner「创建于 …」；成员「加入于 … · 由 XX 邀请」
      members.forEach((m) => {
        const date = m.joinedAt ? fmtCloudDate(m.joinedAt) : ''
        const byName = m.invitedByName || (m.invitedBy ? nameMap[m.invitedBy] : '') || ''
        if (m.role === 'owner') {
          m.subLabel = date ? '创建于 ' + date : '创建者'
        } else {
          m.subLabel = (date ? '加入于 ' + date : '已加入') + (byName ? ' · 由 ' + byName + ' 邀请' : '')
        }
        m.displayName = m._openid === myOpenid
          ? '我（' + (m.nickname || '未设置昵称') + '）'
          : (m.nickname || '未设置昵称')
      })

      // 待接受行：备注（有则显示） + 「10-30 过期 · 10-23 14:20 生成 · 由 XX 发出」
      // 最新的排在最前，刚发出去还没备注时也认得出是哪条
      pending.forEach((p) => {
        const ymd = p.expireAt ? fmtCloudDate(p.expireAt) : ''
        const byName = p.inviterName || (p.inviterOpenid ? nameMap[p.inviterOpenid] : '') || ''
        p.label = p.label || ''
        p.createdLabel = p.createdAt ? fmtCloudDateTime(p.createdAt) + ' 生成' : ''
        p.expireLabel = [
          ymd ? ymd.slice(5) + ' 过期' : '',
          p.createdLabel,
          byName ? '由 ' + byName + ' 发出' : ''
        ].filter(Boolean).join(' · ')
      })
      pending.sort((a, b) => (toTs(b.createdAt) || 0) - (toTs(a.createdAt) || 0))
      // 行内提示（不弹窗打扰）：有多条、或存在未备注的邀请时才提示可命名
      const hasUnlabeled = pending.some((p) => !p.label)

      const memberCount = members.length
      const isFull = memberCount >= config.MAX_MEMBERS
      this._loaded = true
      this.setData({
        members,
        memberCount,
        myRole: (mRes && mRes.myRole) || 'member',
        myOpenid,
        myNotify: !!(mRes && mRes.myNotify),
        pending,
        hasUnlabeled,
        invitedByNames: nameMap,
        isFull,
        barPct: Math.min(100, Math.round((memberCount / config.MAX_MEMBERS) * 100)),
        barLabel: isFull ? '已满员' : `还可邀请 ${config.MAX_MEMBERS - memberCount} 人`,
        loadError: ''
      })

      // 宠物卡（从 store 已加载列表取；展示品种·年龄）
      const pet = (store.state.pets || []).find((p) => p._id === petId)
      this.setData({
        pet,
        petInfo: pet ? [pet.breed, util.formatAge(pet.birthday)].filter(Boolean).join(' · ') : ''
      })
      this._petName = pet ? pet.name : '这只宠物'
    } catch (e) {
      // 项目规约：异步失败置内联错误条，不整页空白；错误信息可见便于定位
      console.error('[members] 加载失败', e)
      this.setData({
        loadError: '加载失败：' + String((e && e.message) || '未知错误').slice(0, 80)
      })
    }
  },

  // PRD 5.1：发起邀请（按钮 open-type=share 触发；卡面图走 invite-card 生成，对齐设计稿）
  async onShareAppMessage() {
    return inviteShare.build(this, this.data.pet, 'card')
  },

  /**
   * 待接受邀请行点击 → 操作菜单（写备注 / 撤销）
   * 多个待接受邀请长得一模一样，只能靠备注区分，所以「改备注」做成一等入口
   */
  onPendingTap(e) {
    const { inviteid, label, created } = e.currentTarget.dataset
    wx.showActionSheet({
      itemList: ['写个备注（发给谁）', '撤销这个邀请'],
      success: (res) => {
        if (res.tapIndex === 0) this.promptLabel(inviteid, label)
        else this.confirmRevoke(inviteid, label, created)
      },
      fail: () => {}
    })
  },

  /** 备注输入：wx.showModal editable（基础库 2.17.1+） */
  promptLabel(inviteId, cur) {
    wx.showModal({
      title: '这个邀请发给谁',
      content: cur || '',
      editable: true,
      placeholderText: '例如：发给妈妈',
      confirmText: '保存',
      cancelText: '取消',
      success: async (res) => {
        if (!res.confirm) return
        const label = String(res.content || '').trim().slice(0, 12)
        try {
          await db.updateInviteLabel(inviteId, label)
          util.toast(label ? '已保存备注' : '已清除备注')
          this.load()
        } catch (err) {
          util.toast('保存失败')
        }
      }
    })
  },

  /** 撤销确认：文案里写明是「哪一条」，避免多条时撤错 */
  confirmRevoke(inviteId, label, created) {
    const who = label ? `「${label}」这个邀请` : (created ? `${created} 的邀请` : '这个邀请')
    util.confirmDelete(
      `将撤销${who}，对方将无法通过它加入，确定撤销？`,
      async () => {
        try {
          await db.revokeInvite(inviteId)
          util.toast('已撤销')
          this.load()
        } catch (err) {
          util.toast('撤销失败')
        }
      },
      { title: '确认撤销', confirmText: '撤销' }
    )
  },

  // PRD 5.3：撤销邀请（行内撤销按钮 → 复用上面的确认）
  onRevoke(e) {
    const { inviteid, label, created } = e.currentTarget.dataset
    this.confirmRevoke(inviteid, label, created)
  },

  // PRD 5.3：移除成员（仅 owner）
  onRemove(e) {
    const { openid, name } = e.currentTarget.dataset
    util.confirmDelete(
      `移除后「${name}」将无法再查看这只宠物的数据，确定移除？`,
      async () => {
        try {
          await db.removeMember(this.data.petId, openid)
          track.track('member_removed', { petId: this.data.petId, role: this.data.myRole, via: 'removed' })
          // 成员数变了：清缓存，让首页 onShow 的 syncPetsMeta 能拿到最新 memberCount
          db.invalidateAll()
          util.toast('已移除')
          this.load()
        } catch (err) {
          util.toast('移除失败')
        }
      },
      { title: '确认移除', confirmText: '移除' }
    )
  },

  // PRD 5.3：退出共享（仅 member）
  onQuit() {
    util.confirmDelete(
      '退出后将无法再查看这只宠物的数据，确定退出？',
      async () => {
        try {
          await db.quitMember(this.data.petId)
          track.track('member_removed', { petId: this.data.petId, role: this.data.myRole, via: 'quit' })
          db.invalidateAll()
          util.toast('已退出')
          setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }), 400)
        } catch (err) {
          util.toast('退出失败')
        }
      },
      { title: '确认退出', confirmText: '退出' }
    )
  },

  // PRD 5.6：关自己的 notify
  async onToggleNotify(e) {
    const notify = e.detail.value
    try {
      await db.updateNotify(this.data.petId, notify)
      this.setData({ myNotify: notify })
    } catch (err) {
      util.toast('设置失败')
      // 回滚开关
      this.setData({ myNotify: !notify })
    }
  }
})
