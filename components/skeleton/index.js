/**
 * skeleton：骨架屏（列表页通用加载态，不用全屏 loading）
 * type: card（健康页卡片组）/ line（记账流水行）/ timeline（时间线）
 */
Component({
  properties: {
    type: { type: String, value: 'card' },
    rows: { type: Number, value: 3 }
  },
  data: { items: [1, 2, 3] },
  observers: {
    rows(v) {
      this.setData({ items: Array.from({ length: v }, (_, i) => i) })
    }
  }
})
