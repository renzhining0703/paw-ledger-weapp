/**
 * empty-state：场景化空状态（插画 + 文案 + 主按钮），禁止统一「暂无数据」
 */
Component({
  properties: {
    /** 插画：no-pet / no-health / no-cost / net-error */
    type: { type: String, value: 'no-pet' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    btnText: { type: String, value: '' }
  },
  methods: {
    onTap() {
      this.triggerEvent('action')
    }
  }
})
