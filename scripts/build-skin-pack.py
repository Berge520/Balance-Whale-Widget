# -*- coding: utf-8 -*-
"""
内置形象「随包 1 张 + 可选下载 1 张」的素材构建脚本（一次性 / 发版前手动跑）

为什么要有这个脚本：
  v1.7.x 起 13 张内置形象只保留 DSniang1 随包分发（约 39KB），其余改为按需下载，
  目的是把 zip 从约 2.7MB 压到约 1.7MB。
  v1.8.0 起进一步精简：原先打包的 12 张里有 11 张与「共享角色包」（resources/assets-skins
  .whaleassets 的 36 张）是**同一张图的重复** —— 那批本是用户在 QQ 群里挑一部分转 webp
  单独打包，而原图同时也在共享角色包里整包分发。重复项里内置版还是重压的低质量 webp，
  共享版则是原图。故内置包只留真正独有的 DSniang02（带思考气泡的蓝发角色），
  其余 11 张一律改由共享角色包提供，避免画廊里出现两张一样的图。
  （判定依据：64x64 灰度感知哈希，DSniang02 与共享 36 张最近距离 1365/4096，其余 11 张
   全部 ≤64/4096，DSniang3 经肉眼复核确认与共享包 s52fa3a3e51 同图。）

它做三件事：
  1. 为远程形象生成小缩略图（webp，最长边 96px），内嵌进设置页，
     让用户「下载前也能看见长什么样」。
  2. 把原图按 assets.js 的自定义容器格式（.whaleassets）打成一个素材包，
     作为 GitHub Release 附件发布。复用容器格式而不是 zip：宿主 preload 只有
     Node 内置模块，解 zip 要自己写 CRC32 + 中央目录（assets.js 注释里明确记过这个坑）。
  3. 打印每张图的 sha256，供 constants.js 的远程清单填校验值。

产物（都在 public/whale-pack/ 下，随插件分发）：
  - thumbs/<id>.webp      设置页内嵌用的小缩略图
  - skins-pack.whaleassets  远程素材包本体（发 Release 用，不进插件包）
  - manifest.json          id → { file, sha256, size }，供核对

跑法：python scripts/build-skin-pack.py
依赖：Pillow（pip install Pillow）
"""
import hashlib
import io
import json
import os
import struct

try:
    from PIL import Image
except ImportError:
    raise SystemExit('需要 Pillow：pip install Pillow')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 源图目录：**不在 public/ 下** —— public/ 会被 Vite 拷进插件包，源图不该随包分发
# （那等于把「按需下载」白做）。v1.8.0 起源图存这里，与 resources/ 的其他产物同处一地。
SRC = os.path.join(ROOT, 'resources', 'skins-src')
OUT = os.path.join(ROOT, 'public', 'whale-pack')
THUMB_DIR = os.path.join(OUT, 'thumbs')

# 随包保留的默认形象，不参与远程包（它不在此脚本管辖范围内，列出仅为语义完整）
KEEP = 'DSniang1.webp'
# 只打包「内置可下载形象」。命名约定不足以筛选（public/whale/ 下还有 rua.webp 气泡动图等
# 非形象资源），故用本集合做白名单。
# v1.8.0 起从 12 张精简为 1 张：其余 11 张与共享角色包同图（见文件头说明），
# 一律改由共享角色包提供，这里只留真正独有的 DSniang02。
SKIN_IDS = {
    'DSniang02',
}
# 素材包内文件主干（不含扩展名）→ 落盘 id 的改名表。默认两者相同（见下方 skin_id 赋值）；
# 只有原文件名吃不下 skins.js 的 id 白名单（`/^[A-Za-z0-9_-]{1,40}$/`）时才在此登记 ——
# 如「无稽之谈改」这类中文名，落盘 id 取拼音首字母，与 glby/ciya/liuy 同风格。
# 漏登记的后果：该张能写进磁盘、却会在 readRaw 归一化时被静默丢弃（画廊少一张、且反复重下）。
# v1.8.0 起 12 张仅剩 DSniang02，其文件名已是合法 ASCII，故当前为空表（保留结构备用）。
RENAME = {}
# 缩略图最长边：设置页网格里是约 64px 的格子，96 给高分屏留余量
THUMB_MAX = 96

# assets.js 的容器格式常量，必须与 public/preload/lib/assets.js 完全一致
MAGIC = b'WHALEASSET1'
KIND = 'balance-whale-widget-assets'
SCHEMA = 1


def main():
    os.makedirs(THUMB_DIR, exist_ok=True)

    if not os.path.isdir(SRC):
        raise SystemExit('源图目录不存在：%s（应放待打包的形象原图）' % SRC)

    files = sorted(
        f for f in os.listdir(SRC)
        if f.lower().endswith('.webp')
        and os.path.splitext(f)[0] in SKIN_IDS
    )
    if not files:
        raise SystemExit('源图目录里没有可打包的形象（对照 constants.SKIN_PACK_SKINS）：%s' % SRC)

    skin_list = []
    blobs = []
    off = 0
    manifest = {}
    written_thumbs = set()

    for name in files:
        stem = os.path.splitext(name)[0]
        # 落盘 id：默认取文件主干，中文等不合法名走 RENAME 表换成 ASCII（见上方注释）
        skin_id = RENAME.get(stem, stem)
        src = os.path.join(SRC, name)
        with open(src, 'rb') as fh:
            data = fh.read()

        # 缩略图：等比缩到最长边 96px，转 webp(q88) 保留 alpha
        with Image.open(src) as im:
            im = im.convert('RGBA')
            im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'WEBP', quality=88, method=6)
            thumb = buf.getvalue()
        thumb_path = os.path.join(THUMB_DIR, skin_id + '.webp')
        with open(thumb_path, 'wb') as fh:
            fh.write(thumb)
        written_thumbs.add(skin_id + '.webp')

        digest = hashlib.sha256(data).hexdigest()
        manifest[skin_id] = {
            'file': name,
            'sha256': digest,
            'size': len(data),
            'thumbSize': len(thumb),
        }

        # 容器清单项：off/len 指向拼接后的数据区。
        # id 是落盘 id（RENAME 换名后的），file 保留素材包里的原始文件名 —— 导入方按 file
        # 匹配 constants.SKIN_PACK_SKINS、按 id 落盘（见 skin-packs.js），两者可以不同。
        # builtin=True 让导入方（skins.importBuffer）识别成内置图：走固定 id、不占自建配额
        skin_list.append({
            'id': skin_id,
            'builtin': True,
            'name': name,
            'ext': 'webp',
            'at': 0,
            'current': False,
            'off': off,
            'len': len(data),
            'thumbOff': 0,
            'thumbLen': 0,
        })
        blobs.append(data)
        off += len(data)

    pack_manifest = {
        'kind': KIND,
        'schema': SCHEMA,
        'appVersion': '1.8.0',
        'exportedAt': 'builtin-skin-pack-v2',
        'skins': skin_list,
        'sounds': [],
        'bubbles': [],
    }
    json_buf = json.dumps(pack_manifest, ensure_ascii=False).encode('utf-8')
    head = MAGIC + struct.pack('<I', len(json_buf))
    pack_path = os.path.join(OUT, 'skins-pack.whaleassets')
    with open(pack_path, 'wb') as fh:
        fh.write(head)
        fh.write(json_buf)
        for b in blobs:
            fh.write(b)

    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    # 清理陈旧缩略图：源图被移出 SKIN_IDS 后，thumbs/ 里对应的 webp 不会被覆盖删除，
    # 会随 Vite 一起进插件包（白白占体积，且设置页不再引用）。以本次实写集合为准做差集。
    stale = [
        f for f in os.listdir(THUMB_DIR)
        if f.lower().endswith('.webp') and f not in written_thumbs
    ]
    for f in stale:
        os.remove(os.path.join(THUMB_DIR, f))

    total = sum(m['size'] for m in manifest.values())
    thumb_total = sum(m['thumbSize'] for m in manifest.values())
    pack_size = os.path.getsize(pack_path)
    print('形象 %d 张' % len(files))
    print('原图合计 %.0f KB' % (total / 1024))
    print('缩略图合计 %.1f KB' % (thumb_total / 1024))
    if stale:
        print('清理陈旧缩略图 %d 张：%s' % (len(stale), ', '.join(sorted(stale))))
    print('素材包 %.0f KB -> %s' % (pack_size / 1024, pack_path))
    print('清单 %s' % os.path.join(OUT, 'manifest.json'))


if __name__ == '__main__':
    main()
