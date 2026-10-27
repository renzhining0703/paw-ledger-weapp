#!/usr/bin/env python3
# 把设计稿用到的时间线节点 emoji 渲染成 PNG（一次性工具，产物已入库，无需重复运行）
from PIL import Image, ImageDraw, ImageFont
import os

OUT = 'assets/icons-png'
os.makedirs(OUT, exist_ok=True)
EMOJI = '/System/Library/Fonts/Apple Color Emoji.ttc'
# 新版 macOS 没有独立的 PingFang 文件（进了 dyld 缓存），用 Hiragino Sans GB 渲染 ♀♂ 字形
PINGFANG = '/System/Library/Fonts/Hiragino Sans GB.ttc'

NODE = {
    'node-vaccine': '💉', 'node-dewormIn': '💊', 'node-dewormOut': '🛡️',
    'node-checkup': '🩺', 'node-weight': '⚖️', 'node-daily': '✨',
    'node-home': '🏠', 'node-birthday': '🎂',
}
GENDER = {'ic-gender-f-share': ('♀', '#E56A8C'), 'ic-gender-m-share': ('♂', '#4A7DE0')}

def render_emoji(ch, size=96):
    """彩色 emoji：sbix 点阵字体（只支持固定 strike，从大到小探测可用字号）；
    渲染后裁剪，等比缩放到目标尺寸"""
    last_err = None
    for strike in range(160, 47, -8):
        try:
            f = ImageFont.truetype(EMOJI, strike)
        except OSError as e:
            last_err = e
            continue
        img = Image.new('RGBA', (strike * 3, strike * 3), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.text((int(strike * 1.5), int(strike * 1.5)), ch, font=f, embedded_color=True, anchor='mm')
        bbox = img.getbbox()
        if not bbox:
            raise SystemExit('渲染为空: ' + ch)
        return img.crop(bbox)
    raise SystemExit('无可用字号: %s (%s)' % (ch, last_err))

def render_text_glyph(ch, color, size=96):
    """单色文字字形（♀♂ 用 PingFang 渲染，颜色与设计稿一致）"""
    f = ImageFont.truetype(PINGFANG, size)
    img = Image.new('RGBA', (size * 2, size * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((size, size), ch, font=f, fill=color, anchor='mm')
    bbox = img.getbbox()
    if not bbox:
        raise SystemExit('渲染为空: ' + ch)
    return img.crop(bbox)

def save_square(img, name, box=96, pad=6):
    """等比缩放进 box×box 正方形（四周留 pad 余量），居中保存"""
    w, h = img.size
    s = (box - pad * 2) / max(w, h)
    img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    canvas = Image.new('RGBA', (box, box), (0, 0, 0, 0))
    canvas.paste(img, ((box - img.width) // 2, (box - img.height) // 2), img)
    canvas.save(os.path.join(OUT, name + '.png'))
    print('OK', name, img.size)

for name, ch in NODE.items():
    save_square(render_emoji(ch), name)
for name, (ch, color) in GENDER.items():
    save_square(render_text_glyph(ch, color), name)
print('ALL-DONE')
