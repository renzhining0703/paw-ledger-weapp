/**
 * pet-switcher：切换宠物底部弹框（首页 / 健康 / 记账共用）
 * 列表头像+昵称+品种·年龄，当前项主色描边勾选，底部「＋添加宠物」
 *
 * 排序规则：当前选中的宠物固定排第一（多宠物时不会被列表推出可视区），
 * 其余按创建顺序原样排列；换选后下次打开，新选中置顶、原选中回到原位。
 */
const U = require('../../utils/util')

Component({
  properties: {
    show: { type: Boolean, value: false },
    pets: { type: Array, value: [] },
    currentId: { type: String, value: '' },
    /**
     * 副标题：不传就用默认的「共 N 只毛孩子」。
     * 相册页传「切换后，这里的照片也会跟着换」（设计稿 albsw 的口径）
     */
    subtitle: { type: String, value: '' },
    /** { [petId]: 照片张数 }（相册页用；有值就在 info 末尾追加「N 张 / 还没有照片」） */
    counts: { type: Object, value: {} },
    /**
     * 隐藏底部「＋添加宠物」。
     * 设计稿 albsw 明确去掉：在相册页加宠物没有下文（加了也没有照片），
     * 首页/健康/记账保留（那儿加完就能直接记一笔）。
     */
    hideAdd: { type: Boolean, value: false }
  },
  data: { items: [], scrollTop: 0 },
  observers: {
    'pets, currentId, counts'(pets, currentId, counts) {
      const map = counts || {}
      const list = (pets || []).map((p) => {
        const age = U.formatAge(p.birthday)
        const base = age ? ((p.breed ? p.breed + ' · ' : '') + age) : (p.breed || '')
        const n = map[p._id]
        const tail = n == null ? '' : (n > 0 ? `${n} 张` : '还没有照片')
        return {
          _id: p._id,
          name: p.name,
          avatar: p.avatar || '',
          avatarSmall: p.avatarSmall || '',
          species: p.species,
          isShared: p.myRole === 'member',
          info: [base, tail].filter(Boolean).join(' · ')
        }
      })
      // 选中置顶，其余保持创建顺序（稳定：不动数据，只动视图）
      const cur = list.find((p) => p._id === currentId)
      const rest = list.filter((p) => p._id !== currentId)
      this.setData({ items: cur ? [cur, ...rest] : list })
    },
    // 每次打开都回到顶部：选中项在第一位，置顶即可见，不残留上次的滚动位置
    show(v) {
      if (v) this.setData({ scrollTop: 0 })
    }
  },
  methods: {
    onSelect(e) {
      const id = e.currentTarget.dataset.id
      this.triggerEvent('select', { petId: id })
      this.triggerEvent('close')
    },
    onAdd() {
      this.triggerEvent('add')
      this.triggerEvent('close')
    },
    onClose() {
      this.triggerEvent('close')
    }
  }
})
