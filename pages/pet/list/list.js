/**
 * 宠物管理页：列表 + 记录条数 + 删除二次确认（提示 N 条记录）+ 20 只上限
 */
const store = require('../../../utils/store')
const db = require('../../../utils/db')
const U = require('../../../utils/util')
const config = require('../../../utils/config')
const inviteShare = require('../../../utils/invite-share')

Page({
  data: {
    loading: true,
    pets: [],
    counts: {},
    total: 0,
    full: false,
    maxMembers: config.MAX_MEMBERS
  },

  onShow() {
    this.refresh()
  },

  async refresh() {
    try {
      await getApp().ready(2000)
      const pets = await db.listPets(true)
      store.state.pets = pets
      // 各宠物记录条数（health+weights+daily+expenses）
      const counts = {}
      let total = 0
      await Promise.all(pets.map(async (p) => {
        const [h, w, d, e] = await Promise.all([
          db.listBy('health', p._id).catch(() => []),
          db.listBy('weights', p._id).catch(() => []),
          db.listBy('daily', p._id).catch(() => []),
          db.listBy('expenses', p._id).catch(() => [])
        ])
        const n = h.length + w.length + d.length + e.length
        counts[p._id] = n
        total += n
      }))
      this.setData({
        loading: false,
        pets: pets.map((p) => ({
          ...p,
          // 无头像由 pet-avatar 组件按物种 emoji 兜底
          avatar: p.avatar || '',
          info: [p.breed, U.formatAge(p.birthday)].filter(Boolean).join(' · '),
          count: counts[p._id] || 0
        })),
        total,
        full: pets.length >= config.MAX_PETS
      })
      this._counts = counts
    } catch (e) {
      console.error('宠物列表加载失败', e)
      this.setData({ loading: false })
      U.toast('加载失败，请重试')
    }
  },

  noop() {},

  onAdd() {
    if (this.data.full) {
      U.toast(`最多添加 ${config.MAX_PETS} 只宠物`)
      return
    }
    wx.navigateTo({ url: '/pages/pet/edit/edit' })
  },

  onItem(e) {
    // 二期改版：点整行进档案详情页（查看为主，owner 可从详情页进编辑）
    wx.navigateTo({ url: '/pages/pet/profile/profile?petId=' + e.currentTarget.dataset.id })
  },

  /**
   * 行内「邀请」按钮直接发起共享转发（open-type=share 触发）。
   * petId 从按钮 dataset 取（res.target）；右上角菜单转发无 target，回落 app 首页。
   * 卡面图走 invite-card 生成（5:4，对齐设计稿）。
   */
  async onShareAppMessage(res) {
    const petId = res && res.target && res.target.dataset.id
    if (!petId) {
      return { title: `${config.APP_NAME} · 和家人一起记录毛孩子`, path: '/pages/home/home' }
    }
    const pet = this.data.pets.find((p) => p._id === petId)
    return inviteShare.build(this, pet, 'list')
  },

  /** 左滑删除入口（这里用长按触发，简单可靠） */
  onItemLongPress(e) {
    const id = e.currentTarget.dataset.id
    const pet = this.data.pets.find((p) => p._id === id)
    if (!pet) return
    const n = this._counts[id] || 0
    const memberCount = pet.memberCount || 1
    // PRD 5.5 / 第7节：删除共享宠物文案须写明 N 位成员将同时失去数据
    const msg = memberCount > 1
      ? `这只宠物有 ${memberCount} 位成员，删除后 ${memberCount} 人将同时失去这只宠物的全部数据（共 ${n} 条记录），且不可恢复`
      : `这只宠物名下的 ${n} 条记录将一并删除，无法恢复`
    U.confirmDelete(
      msg,
      async () => {
        try {
          wx.showLoading({ title: '删除中…' })
          await db.removePet(id)
          wx.hideLoading()
          require('../../../utils/track').track('pet_deleted', { recordCount: n, memberCount })
          if (store.state.currentPetId === id) {
            store.setCurrentPet(null)
            const rest = store.state.pets.filter((p) => p._id !== id)
            if (rest.length) store.setCurrentPet(rest[0]._id)
          }
          U.toast('已删除')
          this.refresh()
        } catch (err) {
          wx.hideLoading()
          console.error('删除宠物失败', err)
          U.toast('删除失败，请重试')
        }
      }
    )
  }
})
