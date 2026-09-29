# -*- coding: utf-8 -*-
"""
上游 QQ 群分享素材（共享角色 + 音效库）的素材包构建脚本（一次性 / 发版前手动跑）

为什么要有这个脚本：
  这两批素材来自上游 QQ 群分享，**不进插件包、也不进仓库**（见 .gitignore 的 assets-src/）：
  角色图 36 张约 41.6MB、音频 45 个约 2.7MB，随包分发既撑爆体积也放大版权风险。
  改为打包挂 GitHub Release，用户按需下载（与 skins-pack.whaleassets 同一套路）。

与 build-skin-pack.py 的区别：
  - 那个打「内置可下载形象」（v1.9.0 起 1 张），是插件自带资源的瘦身；
  - 这个打「上游分享素材」，是纯粹的可选扩展内容，**不随包**，
    因此产物落在 resources/ 而不是 public/ —— public/ 会被 Vite 原样拷进插件包。

它做四件事：
  1. 角色图：为每张生成缩略图（webp，最长边 192px）内嵌进设置页，让用户下载前能看见。
  2. 角色图：把 36 张原图打成 assets-skins.whaleassets（复用 assets.js 的容器格式，不用 zip）。
  3. 音频：把 45 个音频打成 assets-sounds.whaleassets。
  4. 打印两份包的 sha256 与逐项 sha256 / 体积清单，供 constants.js 与设置页填表。

产物（都在 resources/ 下）：
  - thumbs/<id>.webp          角色图缩略图（设置页网格用）
  - assets-skins.whaleassets  角色图素材包（发 Release 用）
  - assets-sounds.whaleassets 音效素材包（发 Release 用）
  - manifest.json             id → { file, sha256, size }，供核对

跑法：python scripts/build-assets-pack.py
依赖：Pillow（pip install Pillow）
"""
import hashlib
import io
import json
import os
import re
import struct
import unicodedata

try:
    from PIL import Image
except ImportError:
    raise SystemExit('需要 Pillow：pip install Pillow')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_SKINS = os.path.join(ROOT, 'assets-src', 'skins')
SRC_SOUNDS = os.path.join(ROOT, 'assets-src', 'sounds')
OUT = os.path.join(ROOT, 'resources')
THUMB_DIR = os.path.join(OUT, 'thumbs')

# 角色图缩略图最长边：设置页网格是约 64px 的格子，192 给高分屏与放大镜留足余量。
# 36 张 webp(q85) 合计约 150KB —— 相对随时可下的原图是小成本，换来「下前能看」。
THUMB_MAX = 192
# 音频不生成缩略图（试听即预览），但音量/时长无法在离线脚本里可靠读出，故不统计

# assets.js 的容器格式常量，必须与 public/preload/lib/assets.js 完全一致
MAGIC = b'WHALEASSET1'
KIND = 'balance-whale-widget-assets'
SCHEMA = 1

# 形象 id 的安全化：skins.js 的 normItem 只接受 ^[A-Za-z0-9_-]{1,40}$（id 会拼进文件名），
# 而角色图原名多为中文（如「三月七（啥子）」）。**不能放宽 id 规则** —— 那会牵动已落盘
# 数据的兼容面。改为「打包时生成 ASCII id、中文原名留作展示名」（清单里 name 字段）。
# 生成规则：原名 → 拼音/音译不可靠，故用确定性短哈希；同名前缀冲突也天然避开。
def safe_id(name, used):
    base = unicodedata.normalize('NFKD', name)
    ascii_only = re.sub(r'[^A-Za-z0-9_-]', '', base)
    if len(ascii_only) >= 2:
        base_id = ascii_only[:40].strip('_-')
        if base_id and base_id not in used:
            used[base_id] = True
            return base_id
    # 中文名走这里：用 sha1 前 10 位做稳定 id（同名同值，重跑脚本 id 不变）
    h = hashlib.sha1(name.encode('utf-8')).hexdigest()[:10]
    base_id = 's' + h
    while base_id in used:
        base_id += '0'
    used[base_id] = True
    return base_id


# 音频 id 同样安全化：原名含中文与空格（如「全体目光向我看齐_爱给网_aigei_com」）
def sound_id(name, used):
    stem = os.path.splitext(name)[0]
    ascii_only = re.sub(r'[^A-Za-z0-9_-]', '', unicodedata.normalize('NFKD', stem))
    if len(ascii_only) >= 2:
        base_id = ascii_only[:40].strip('_-')
        if base_id and base_id not in used:
            used[base_id] = True
            return base_id
    h = hashlib.sha1(stem.encode('utf-8')).hexdigest()[:10]
    base_id = 'a' + h
    while base_id in used:
        base_id += '0'
    used[base_id] = True
    return base_id


def pack(items, out_path):
    """items: [{ id, name, ext, data, builtin }] → 写 .whaleassets 容器。
    清单项字段与 assets.js#exportAssets 对齐（builtin=True 让导入侧走固定 id、不占配额）。"""
    skin_list = []
    blobs = []
    off = 0
    for it in items:
        data = it['data']
        skin_list.append({
            'id': it['id'],
            'builtin': True,
            'name': it['name'],
            'ext': it['ext'],
            'at': 0,
            'current': False,
            'off': off,
            'len': len(data),
            'thumbOff': 0,
            'thumbLen': 0,
        })
        blobs.append(data)
        off += len(data)
    manifest = {
        'kind': KIND,
        'schema': SCHEMA,
        'appVersion': '1.0.0',
        'exportedAt': 'shared-assets-pack-v1',
        'skins': skin_list,
        'sounds': [],
        'bubbles': [],
    }
    json_buf = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
    with open(out_path, 'wb') as fh:
        fh.write(MAGIC)
        fh.write(struct.pack('<I', len(json_buf)))
        fh.write(json_buf)
        for b in blobs:
            fh.write(b)
    return os.path.getsize(out_path)


def main():
    os.makedirs(THUMB_DIR, exist_ok=True)
    if not os.path.isdir(SRC_SKINS):
        raise SystemExit('缺少素材源目录 %s（上游 QQ 群素材，不进仓库，需发布者本地保留）' % SRC_SKINS)

    # ── 角色图 ──
    used = {}
    skin_items = []
    skin_manifest = {}
    for name in sorted(os.listdir(SRC_SKINS)):
        if not name.lower().endswith('.png'):
            continue
        src = os.path.join(SRC_SKINS, name)
        with open(src, 'rb') as fh:
            data = fh.read()
        disp = os.path.splitext(name)[0]
        sid = safe_id(disp, used)

        # 缩略图：等比缩到最长边 192，转 webp(q85) 保留 alpha
        with Image.open(src) as im:
            im = im.convert('RGBA')
            im.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'WEBP', quality=85, method=6)
            thumb = buf.getvalue()
        with open(os.path.join(THUMB_DIR, sid + '.webp'), 'wb') as fh:
            fh.write(thumb)

        skin_items.append({'id': sid, 'name': disp, 'ext': 'png', 'data': data})
        skin_manifest[sid] = {
            'name': disp, 'file': name,
            'sha256': hashlib.sha256(data).hexdigest(),
            'size': len(data), 'thumbSize': len(thumb),
        }

    # ── 音效 ──
    used_s = {}
    sound_items = []
    sound_manifest = {}
    if os.path.isdir(SRC_SOUNDS):
        for name in sorted(os.listdir(SRC_SOUNDS)):
            ext = os.path.splitext(name)[1].lower().lstrip('.')
            if ext not in ('mp3', 'ogg', 'wav', 'm4a'):
                continue
            src = os.path.join(SRC_SOUNDS, name)
            with open(src, 'rb') as fh:
                data = fh.read()
            disp = os.path.splitext(name)[0]
            sid = sound_id(name, used_s)
            sound_items.append({'id': sid, 'name': disp, 'ext': ext, 'data': data})
            sound_manifest[sid] = {
                'name': disp, 'file': name, 'ext': ext,
                'sha256': hashlib.sha256(data).hexdigest(),
                'size': len(data),
            }

    skin_pack = os.path.join(OUT, 'assets-skins.whaleassets')
    sound_pack = os.path.join(OUT, 'assets-sounds.whaleassets')
    skin_size = pack(skin_items, skin_pack)
    sound_size = pack(sound_items, sound_pack)

    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump({'skins': skin_manifest, 'sounds': sound_manifest}, fh, ensure_ascii=False, indent=2)

    def digest(p):
        with open(p, 'rb') as fh:
            return hashlib.sha256(fh.read()).hexdigest()

    print('角色图 %d 张，合计 %.1f MB' % (len(skin_items), sum(x['size'] for x in skin_manifest.values()) / 1048576))
    print('  缩略图合计 %.1f KB' % (sum(x['thumbSize'] for x in skin_manifest.values()) / 1024))
    print('  素材包 %.1f MB -> %s' % (skin_size / 1048576, skin_pack))
    print('  整包 sha256 = %s' % digest(skin_pack))
    print('音效 %d 个，合计 %.1f MB' % (len(sound_items), sum(x['size'] for x in sound_manifest.values()) / 1048576))
    print('  素材包 %.1f MB -> %s' % (sound_size / 1048576, sound_pack))
    print('  整包 sha256 = %s' % digest(sound_pack))
    print('清单 %s' % os.path.join(OUT, 'manifest.json'))


if __name__ == '__main__':
    main()
