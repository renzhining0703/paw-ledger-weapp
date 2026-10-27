/**
 * 全局配置：云环境、订阅模板、业务常量
 * ⚠️ 上线前必改：CLOUD_ENV（新云环境 id）、SUBSCRIBE_TEMPLATE_ID（订阅消息模板）
 */
module.exports = {
  /** 云开发环境 ID（新建环境，不复用旧环境 cloud1-8gembxhfa18dcf14） */
  CLOUD_ENV: 'chongwu-d3ggjwmut875c0264',

  /**
   * 小程序名称（品牌名，唯一数据源）
   * ⚠️ 云函数无法 require 这个文件，customer / csSend 里各有一份同名常量，改名要三处一起改
   */
  APP_NAME: '它的时光',

  /** 订阅消息模板 ID（提醒类，一次性订阅）——模板「待办事项提醒」编号 2983 */
  SUBSCRIBE_TEMPLATE_ID: '5ObriH6TGCH2XO2T09gAz01-7OQvEjv3ZV2zVOMM1Es',

  /** 版本号（与「我的」页展示一致） */
  VERSION: '1.0.0',

  /**
   * 协议内容版本（《用户协议》《隐私政策》，见 utils/agreements.js）
   * ⚠️ 协议内容有实质变更时：把这里 +1，并同步把 AGREEMENT_KEY 的 v1 换成 v2（两处都要改）
   *    只改版本号不改 key = 老用户不会重新弹窗，等于变更没生效
   */
  AGREEMENT_VERSION: '1.0.0',

  /** 首次启动协议弹窗的 storage key（同意过就记住；升版换 v2 会重新弹一次） */
  AGREEMENT_KEY: 'tj_agreement_v1',

  /** 调试模式：埋点打印控制台（已上线，保持 false） */
  DEBUG: false,

  /** 单账号宠物上限 */
  MAX_PETS: 20,

  /** 共享宠物：每只宠物成员上限（含 owner） */
  MAX_MEMBERS: 5,

  /** 邀请有效期（天） */
  INVITE_EXPIRE_DAYS: 7,

  /** 共享角标色值（与驱虫青、体检紫同语义体系，不引入新色） */
  SHARED_COLOR: '#1E9A80',

  /** 花销分类（金额以「分」存储） */
  EXPENSE_CATEGORIES: [
    { key: 'food', name: '主粮', color: '#FF7A2F' },
    { key: 'goods', name: '用品', color: '#5B8DEF' },
    { key: 'medical', name: '医疗', color: '#F0483E' },
    { key: 'grooming', name: '美容', color: '#FF7BA3' },
    { key: 'snack', name: '零食', color: '#D99000' },
    { key: 'other', name: '其他', color: '#8C8177' }
  ],

  /**
   * 物种（决定占位头像 emoji / 体重单位默认值 / 是否预置提醒周期）
   * emoji 是头像兜底的唯一数据源（对齐设计稿：猫🐱狗🐶兔🐰鸟🐦仓鼠🐹守宫🦎蛇🐍龟🐢其他❓）
   */
  SPECIES: [
    { key: 'cat', name: '猫', unit: 'kg', preset: true, emoji: '🐱' },
    { key: 'dog', name: '狗', unit: 'kg', preset: true, emoji: '🐶' },
    { key: 'rabbit', name: '兔', unit: 'kg', preset: false, emoji: '🐰' },
    { key: 'bird', name: '鸟', unit: 'g', preset: false, emoji: '🐦' },
    { key: 'hamster', name: '仓鼠', unit: 'g', preset: false, emoji: '🐹' },
    { key: 'gecko', name: '守宫', unit: 'g', preset: false, emoji: '🦎' },
    { key: 'snake', name: '蛇', unit: 'g', preset: false, emoji: '🐍' },
    { key: 'turtle', name: '龟', unit: 'kg', preset: false, emoji: '🐢' },
    { key: 'other', name: '其他', unit: 'kg', preset: false, emoji: '❓' }
  ],

  /** 猫狗常用疫苗名（异宠不预置） */
  VACCINE_PRESETS: ['猫三联', '狂犬', '妙三多', '猫宠爱', '犬四联', '犬八联'],

  /** 疫苗下次日期预填周期（天），仅猫狗 */
  VACCINE_CYCLE_DAYS: 365,
  /** 体检下次日期预填周期（天），所有物种通用（一年一两次） */
  CHECKUP_CYCLE_DAYS: 365,
  /** 体内驱虫预填 +90 天 */
  DEWORM_IN_CYCLE_DAYS: 90,
  /** 体外驱虫预填 +30 天 */
  DEWORM_OUT_CYCLE_DAYS: 30,

  /** 第几针选项 */
  DOSE_OPTIONS: ['首针', '第 2 针', '第 3 针', '加强'],

  /**
   * 绝育状态 —— 「是否绝育」字段的唯一数据源（与 gender 同为展示直用的中文枚举）
   * 落库 key 就是这里的字符串本身，展示直接用；新增/调整选项只改这一处
   * ⚠️ 顺序即 UI 顺序；'未知' 必须在首位，作为未填写时的默认值
   */
  NEUTER_OPTIONS: ['未知', '已绝育', '未绝育'],

  /** 日常快记全量标签（含图标，quick-ball 九宫格用；九宫格已停用，仅保留代码备用） */
  DAILY_TAGS: [
    { key: 'feed', name: '喂食', icon: '/assets/icons-png/daily-feed.png' },
    { key: 'water', name: '喝水', icon: '/assets/icons-png/daily-water.png' },
    { key: 'litter', name: '铲屎', icon: '/assets/icons-png/daily-litter.png' },
    { key: 'bath', name: '洗澡', icon: '/assets/icons-png/daily-bath.png' },
    { key: 'walk', name: '遛弯', icon: '/assets/icons-png/daily-walk.png' },
    { key: 'nail', name: '剪指甲', icon: '/assets/icons-png/daily-nail.png' },
    { key: 'food2', name: '换粮', icon: '/assets/icons-png/daily-food.png' },
    // 体检已升级为健康记录类型（HEALTH_TYPES.checkup），这里仅留给停用的 quick-ball 九宫格
    { key: 'checkup', name: '体检', icon: '/assets/icons-png/daily-checkup.png' },
    { key: 'other', name: '其他', icon: '/assets/icons-png/daily-other.png' }
  ],

  /**
   * 日常记录全部类型池 —— 「记一条日常」弹框与随手记常用配置的唯一数据源
   * 新增日常项目只改这里（key 落库，name/emoji/placeholder 用于展示），页面与组件不写死枚举
   * 筛选原则（PRD《随手记自定义常用》1.4）：只加「三个月后回看有价值」的纯事实型；
   * 描述型交给图文。喂食/铲屎/剪指甲/疫苗/驱虫/体检/称重明确不加（双入口或无回看价值）
   */
  DAILY_PICK: [
    { key: 'bath', name: '洗澡', emoji: '🛁', placeholder: '例如：用了新沐浴露，很乖' },
    { key: 'food2', name: '换粮', emoji: '🍚', placeholder: '例如：换成幼宠粮，按 1/4 掺着换' },
    { key: 'med', name: '喂药', emoji: '💊', placeholder: '例如：驱虫药，连吃 3 天' },
    { key: 'sick', name: '不舒服', emoji: '🤒', placeholder: '例如：吐了两次，精神还行' },
    { key: 'groom', name: '美容', emoji: '✂️', placeholder: '例如：剪成小狮子，花了 120' },
    { key: 'out', name: '出门', emoji: '🐾', placeholder: '例如：公园遛了 40 分钟' },
    { key: 'activity', name: '宠物活动', emoji: '🎾', placeholder: '例如：玩了 20 分钟逗猫棒' }
  ],

  /**
   * 随手记「常用 3 个」的物种默认预置（PRD 2）
   * 只在用户从未配置过（users.settings.quickDaily 为空）时套用；
   * ⚠️ 用户配置过之后不再按物种重置
   */
  QUICK_DAILY_DEFAULT: {
    dog: ['bath', 'out', 'food2'],
    cat: ['bath', 'food2', 'med'],
    other: ['food2', 'sick', 'med']
  },

  /** 健康记录类型（体检已从「日常快记标签」升级为独立健康类型） */
  HEALTH_TYPES: [
    { key: 'vaccine', name: '疫苗', color: '#4A7DE0', bg: '#EAF1FE' },
    { key: 'dewormIn', name: '体内驱虫', color: '#1E9A80', bg: '#E7F7F2' },
    { key: 'dewormOut', name: '体外驱虫', color: '#1E9A80', bg: '#E7F7F2' },
    { key: 'checkup', name: '体检', color: '#7B61FF', bg: '#F1EEFF' }
  ]
}

/* ================= 随手记常用：校验与物种默认（首页 / daily-picker 共用，别各写一份） ================= */

/** quickDaily 合法性：必须恰好 3 个、无重复、都在类型池里；否则视为「未配置过」（PRD 3.3） */
function normalizeQuickDaily(list) {
  if (!Array.isArray(list) || list.length !== 3) return null
  const keys = module.exports.DAILY_PICK.map((t) => t.key)
  const uniq = [...new Set(list)]
  return uniq.length === 3 && uniq.every((k) => keys.indexOf(k) >= 0) ? uniq : null
}

/** 按物种取默认常用；dog/cat 以外（含兔/鸟/仓鼠/异宠/其他）统一走 other（PRD 2） */
function defaultQuickDaily(species) {
  const map = module.exports.QUICK_DAILY_DEFAULT
  return (map[species] || map.other).slice()
}

module.exports.normalizeQuickDaily = normalizeQuickDaily
module.exports.defaultQuickDaily = defaultQuickDaily
