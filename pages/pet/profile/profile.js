/**
 * pages/pet/profile · 档案详情页（二期新增，对齐「档案页-邀请入口.png」）
 *
 * 定位：查看档案（区别于编辑页 pages/pet/edit）
 * - 首页名片卡 / 宠物管理列表点整行进入本页
 * - owner：点信息卡进编辑档案；可删除宠物；可邀请
 * - member：字段只读（显示提示条）；可邀请（PRD 5.1 成员也可发起）；不能删除
 */
const app = getApp()
const store = require('../../../utils/store')
const db = require('../../../utils/db')
const U = require('../../../utils/util')
const config = require('../../../utils/config')
const track = require('../../../utils/track')
const inviteShare = require('../../../utils/invite-share')

Page({
  data: {
    petId: '',
    pet: null,
    petView: null,
    info: '',
    isShared: false,
    isFull: false,
    isOwner: false,
    memberCount: 1,
    maxMembers: config.MAX_MEMBERS
  },

  onLoad(options) {
    this.setData({ petId: options.petId || '' })
    app.ready(5000).then(() => this.load())
  },

  onShow() {
    // 从编辑页改完档案回来要刷新展示
    if (this._loaded) this.load()
  },

  async load() {
    const petId = this.data.petId
    if (!petId) return
    try {
      // 优先用 store 里已加载的列表（含 myRole/memberCount）；深链进入时强制回源
      let pet = (store.state.pets || []).find((p) => p._id === petId)
      if (!pet) {
        const pets = await db.listPets(true)
        store.state.pets = pets
        pet = pets.find((p) => p._id === petId)
      }
      if (!pet) {
        U.toast('找不到这只宠物')
        setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }), 600)
        return
      }

      // 体重双轨展示：初始体重 = 档案基准值；当前体重 = 最新一条称重流水，没称过回落基准值
      const weights = await db.listBy('weights', petId).catch(() => [])
      const unit = pet.weightUnit || 'kg'
      const initWeight = U.initWeightOf(pet)
      const hasInit = initWeight !== null
      const initText = hasInit ? `${U.fmtWeight(initWeight)} ${unit}` : '暂无'
      const hasRecord = !!(weights && weights.length)
      const curText = hasRecord ? `${U.fmtWeight(weights[0].value)} ${unit}` : initText

      const memberCount = pet.memberCount || 1
      this._loaded = true
      this.setData({
        pet,
        petView: {
          birthday: pet.birthday || '—',
          adoptDay: pet.adoptDay || '—',
          // 是否绝育：历史档案无此字段 / 用户选了「未知」→ 统一显示「未填写」
          // （不能显示成「未知」，那是表单里的选项名，放在档案里像数据异常）
          neutered: pet.neutered && pet.neutered !== '未知' ? pet.neutered : '未填写',
          weight: curText,
          initWeight: initText,
          // 没称过时「当前体重」回落的其实就是初始体重，标一下，免得两行数字一样让人以为重复了
          weightFallback: !hasRecord && hasInit
        },
        info: [pet.breed, U.formatAge(pet.birthday)].filter(Boolean).join(' · '),
        isShared: memberCount > 1,
        isFull: memberCount >= config.MAX_MEMBERS,
        isOwner: pet.myRole === 'owner',
        memberCount
      })
      wx.setNavigationBarTitle({ title: `${pet.name || '它'} 的档案` })
    } catch (e) {
      console.error('[profile] 加载失败', e)
      U.toast('加载失败，请重试')
    }
  },

  /** 成员管理 */
  onMembers() {
    wx.navigateTo({ url: '/pages/pet/members/members?petId=' + this.data.petId })
  },

  /** owner 点信息卡进编辑档案；成员无编辑权限不响应 */
  onEdit() {
    if (!this.data.isOwner) return
    wx.navigateTo({ url: '/pages/pet/edit/edit?id=' + this.data.petId })
  },

  /** PRD 5.1：邀请家人一起记（按钮 open-type=share 触发；卡面图走 invite-card 生成，成员也可发起） */
  async onShareAppMessage() {
    return inviteShare.build(this, this.data.pet, 'card')
  },

  /** 删除宠物（仅 owner）：文案与宠物管理页一致，写明 N 位成员同时失去数据 */
  onDelete() {
    const pet = this.data.pet
    if (!pet) return
    const memberCount = this.data.memberCount
    const msg = memberCount > 1
      ? `这只宠物有 ${memberCount} 位成员，删除后 ${memberCount} 人将同时失去这只宠物的全部数据，且不可恢复`
      : '这只宠物名下的全部记录将一并删除，无法恢复'
    U.confirmDelete(msg, async () => {
      try {
        wx.showLoading({ title: '删除中…' })
        await db.removePet(pet._id)
        wx.hideLoading()
        track.track('pet_deleted', { memberCount })
        if (store.state.currentPetId === pet._id) {
          store.setCurrentPet(null)
          const rest = (store.state.pets || []).filter((p) => p._id !== pet._id)
          if (rest.length) store.setCurrentPet(rest[0]._id)
        }
        U.toast('已删除')
        setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/home' }) }), 400)
      } catch (err) {
        wx.hideLoading()
        console.error('删除宠物失败', err)
        U.toast('删除失败，请重试')
      }
    })
  }
})
