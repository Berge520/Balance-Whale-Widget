/*
 * 常量集中定义（CommonJS）。
 *
 * 注意：PLUGIN_VERSION 由 scripts/sync-version.mjs 在构建前从 package.json 的
 * version 自动写入本文件，请勿手动维护。
 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
const BALANCE_TTL_MS = 25000
const FETCH_TIMEOUT_MS = 20000

// 检查更新：拉取远端 package.json（经 ghfast 加速），只取 version 字段做比对
const UPDATE_CHECK_URL = 'https://ghfast.top/https://raw.githubusercontent.com/Berge520/Balance-Whale-Widget/refs/heads/main/package.json'
// 当前插件版本。uTools 未提供读取插件自身版本的 API，此处由 scripts/sync-version.mjs
// 在构建前从 package.json 的 version 自动写入，无需手动维护
const PLUGIN_VERSION = '1.8.0'
const UPDATE_TTL_MS = 12 * 3600 * 1000

const MIN_SCALE = 0.6
const MAX_SCALE = 2.5

// ──────────────────────────────────────────────
// 可选下载的内置形象（v1.7.x 起随包只留默认那一张）
// ──────────────────────────────────────────────
// 13 张内置形象原先全部随包分发（约 1.07MB，占插件包 39%）。现在只留 DEFAULT_SKIN
// 那张随包，其余打成一个素材包挂在 GitHub Release 上，用户按需下载（v1.8.0 起该可下载包
// 从 12 张精简为 1 张 DSniang02 —— 原 12 张里 11 张与「共享角色包」同图，见下方清单注释）。
//
// 为什么用 assets.js 的自定义容器格式而不是 zip：宿主 preload 跑在渲染进程，只有 Node
// 内置模块，解 zip 要自己写 CRC32 与中央目录（见 assets.js 文件头注释记的坑），
// 而容器格式的打包/解析代码已经现成，直接复用。
//
// 下载源拆成「真源 + 加速前缀」两段，好让 downloadSkinPacks 拼出候选链逐个尝试：
//   真源直连（SKIN_PACK_ORIGIN）在国内不稳，默认走 ghfast 加速前缀（= 改动前的老行为），
//   代理全挂时再退回直连兜底；用户也可在设置页自填前缀排在最前（见 skin-packs.js#sourceChain）。
const SKIN_PACK_ORIGIN = 'https://github.com/Berge520/Balance-Whale-Widget/releases/latest/download/skins-pack.whaleassets'
// 内置默认加速前缀（与 UPDATE_CHECK_URL 同款 ghfast.top）。末尾必须带 '/'，
// 拼接规则是「前缀 + 真源」直接相连（如 https://ghfast.top/https://github.com/…）
const SKIN_PACK_DEFAULT_PREFIX = 'https://ghfast.top/'
const SKIN_PACK_URL = SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_ORIGIN
// 兜底源：仓库 main 分支的 raw 直链。素材包只在发版时更新，main 上这份可能落后于最新
// Release —— 但它**永远指向那个文件本身**（不会像 latest 那样因发版而改名/404），
// 且 raw.githubusercontent.com 与 github.com/releases 是不同的 CDN 路由，Release 侧
// 被墙/挂代理失败时多一条路。放在候选链最后（见 skin-packs.js#sourceChain）。
// 前提：该文件确实提交在仓库 main（.gitignore 里未排除时才存在），否则只会多一次 404。
// 用 raw 域名而非 github.com/.../raw/...：后者会 302 到 raw 域名，直连更省一跳。
const SKIN_PACK_RAW_MAIN = 'https://raw.githubusercontent.com/Berge520/Balance-Whale-Widget/main/public/whale-pack/skins-pack.whaleassets'
// 自填前缀长度上限：正常加速站前缀几十字符，200 足够，也拦住整段粘贴
const SKIN_PACK_PREFIX_MAX = 200
// 素材包本体的 sha256（v1.8.0 起仅 1 张 DSniang02，约 73KB）。下载后先校验再解析，
// 防代理返回残缺/被篡改的字节。素材包内容变更时必须同步更新 —— 由 scripts/build-skin-pack.py 打印。
const SKIN_PACK_SHA256 = '4703377acecb4a8ab699416216e2e65e00e15ca2966652efda9210062b02cd83'
// 单个源的超时。走候选链时每个源各算一次，多个源都卡满才会累加到数倍 —— 见 downloadSkinPacks
const SKIN_PACK_TIMEOUT_MS = 60000
// 体积上限：v1.8.0 起仅 1 张图约 73KB，给 4MB 余量即可拦住代理返回 HTML 错误页这类异常
const SKIN_PACK_MAX_BYTES = 4 * 1024 * 1024

// ──────────────────────────────────────────────
// 共享素材（上游 QQ 群分享的角色图 / 音效，可在线下载）
// ──────────────────────────────────────────────
// 来源见 PROVENANCE.md 第二节第 4 小节：上游交流 QQ 群分享的角色图 36 张（约 40.6MB）
// 与音效 45 个（约 2.7MB）。
//
// v1.9.0 起改为**按需单张下载**：由 scripts/export-shared-assets.mjs 把 assets-src/ 的
// 中文原名素材按 `id.ext` 重命名导出到 public/shared/（入库，走 raw 直链），点哪张下哪张
// —— 原先 40MB 整包经 GitHub Release 下载太慢，且用户多半只想要其中几张。
// 注释里的 v1.9.0 是「该随本次发布」的归属口径，随版本号一起更新；历史事实（如上面
// 「上游 QQ 群」的来源描述）不动。
//
// 与「内置形象」（SKIN_PACK_*）的区别：那是本插件自带的官方形象、按文件名匹配
// （v1.8.0 起随包 1 张 + 可下载 1 张）；这里是第三方共享素材，按 id 匹配、落两条不同链路
// （见 lib/assets-packs.js 文件头）。
//
// raw 直链基址：public/shared/ 下的 <id>.png / <id>.<ext>，单张最大约 2.6MB，不触 jsDelivr
// 20MB 上限（jsDelivr 源待实测通过后再加，见 lib/assets-packs.js#sourceChain）。
const SHARED_RAW_BASE = 'https://raw.githubusercontent.com/Berge520/Balance-Whale-Widget/main/public/shared/'
// 默认加速前缀（与内置形象同款 ghfast.top）；末尾必须带 '/'，拼接规则是「前缀 + 真源」直连
const SHARED_PACK_DEFAULT_PREFIX = 'https://ghfast.top/'
// 单个源的超时：单张最大 2.6MB，30s 足够；候选链最多试 3 个源，最坏累加 90s
const SHARED_PACK_TIMEOUT_MS = 30000
// 单张体积上限：最大单张约 2.6MB，给 8MB 余量，既容得下也拦得住代理返回 HTML 错误页
const SHARED_PACK_MAX_BYTES = 8 * 1024 * 1024

// 共享角色图清单：id → { name, file, sha256, size }。id 是打包时生成的 ASCII 短名
// （中文名含全角括号，通不过 skins.js 的 id 白名单，故原名留作展示 name）。
// 唯一真源，设置页不复制这份清单（缩略图内嵌、清单从宿主 listSharedSkins 来）。
const SHARED_SKIN_PACK_SKINS = [
  { id: 'Q1', name: 'Q版小鲸鱼(配色1)', file: 'Q版小鲸鱼(配色1).png', sha256: '8de78c46b0199d64bd1104f92b227cb0645e7eebab4016cba07cb0fe2f325225', size: 916644 },
  { id: 'Q2', name: 'Q版小鲸鱼(配色2)', file: 'Q版小鲸鱼(配色2).png', sha256: 'c5cbdd1c7ca91ea997436a9992c9079270d120914a234d623ef42a39207bbd80', size: 902234 },
  { id: 'Q3', name: 'Q版小鲸鱼(配色3)', file: 'Q版小鲸鱼(配色3).png', sha256: 'f6627986d472f9f4b27b4cb0087f9e9671c978b03d202e68870dff76a9f14d03', size: 879923 },
  { id: 'sbdd0f63848', name: '三月七（啥子）', file: '三月七（啥子）.png', sha256: '13372d575b06d9a836e89ede77dad95394dfe924b20f61d4a6243d3e40e12a44', size: 1411207 },
  { id: 's98f716c60d', name: '三月七（照相机）', file: '三月七（照相机）.png', sha256: 'c0e71b9ce6d29d14a7a3f983c2d7ecc9d93f6d976f922160bc6a85872f11bd0e', size: 1574902 },
  { id: 's8ecaf6b8b0', name: '两仪式', file: '两仪式.png', sha256: '65d0b7d9799f0696821429fb9ec68b9f45e2d7629eb3cb2bb4c6fa2702b9df62', size: 1309357 },
  { id: 's1a94068ae6', name: '亚丝娜', file: '亚丝娜.png', sha256: '5bf5e1ca81b23db7693c660c55005ad57dcf9705c1eef00c4bee3a6e373069b0', size: 1541735 },
  { id: 's1cba53fc36', name: '优香', file: '优香.png', sha256: 'c7c06dad2d568e007a6ebf9c306160a39c19a86fec1504e3632acc71e35e463c', size: 2323385 },
  { id: 's070d47c13b', name: '凯伊', file: '凯伊.png', sha256: '259ca53d9fdb836896f3e1f40d081bb5e40ef086590f06bb9754e621ae813cf7', size: 332128 },
  { id: 's68c065ada9', name: '原版小鲸鱼(呲牙)', file: '原版小鲸鱼(呲牙).png', sha256: 'b614d5f34d0645dbe24a321a315184284356ea6d04cec2b2444dd821be986a61', size: 262281 },
  { id: 'sc0d50309e4', name: '原版小鲸鱼(表情)', file: '原版小鲸鱼(表情).png', sha256: '7279f4ef5c6fc0ebc3a63b0fe4bdf9532c0867bc462ab5fb9854193bd2cdcb28', size: 1161296 },
  { id: 's00f8c08fa9', name: '原版小鲸鱼(黑配色)', file: '原版小鲸鱼(黑配色).png', sha256: 'af4ec1c15bc235676c27d1c8848c67af0f6b84cb58506ef696aac9da04fe5652', size: 1078891 },
  { id: 'seacc9959c4', name: '原版小鲸鱼', file: '原版小鲸鱼.png', sha256: 'dcc456613dbb1102a4b7ef636a8b622371e33b763489d6249c434fb54248ba5c', size: 255988 },
  { id: 's4db0fec6c4', name: '可露希尔', file: '可露希尔.png', sha256: '8c90d44a2b4664f251edbe0b5e54cf4a9de2a25b1367f4f4698a2708af08ef5d', size: 1313189 },
  { id: 's34d8444337', name: '哥伦比亚', file: '哥伦比亚.png', sha256: 'ad273d54fa9a5e15de46605716411e2576e6f5b4f6b5066979eee00c07ff4fda', size: 351217 },
  { id: 's52fa3a3e51', name: '小鲸鱼(异色)', file: '小鲸鱼(异色).png', sha256: '20422e80526517f701a00c0d4adfe0f802271d0750c4b3043ec3bcac2e689aa7', size: 1232654 },
  { id: 's7c4c1631fb', name: '席德', file: '席德.png', sha256: 'e6519a8fa3692ebcf74b0f9721b6663385463467894cc5f939839dc53e113c9c', size: 1446216 },
  { id: 's52b8efd026', name: '旅行者荧', file: '旅行者荧.png', sha256: 'c1ce01d57869c2c5628b5cd70d59cf3881de7b2b4e92b0a0395bcdb7b984096d', size: 1634660 },
  { id: 's1e815bca0e', name: '春日野穹', file: '春日野穹.png', sha256: 'c00f41c79c730c507cc95ab7c4eecf673434177b6c45e6fb8a74f32ead003fde', size: 1509399 },
  { id: 's74c705e8db', name: '曼波', file: '曼波.png', sha256: '7c2091389ca4e0764d9994c530aed7d5f009a79ccce89c2b9bb44a172d4b69cb', size: 1230269 },
  { id: 's52bf39e5af', name: '未解锁小鲸鱼', file: '未解锁小鲸鱼.png', sha256: '7d831ed84f5951cbf81e8de43bb866ce6255bca1ba67b675476f48322f0fb2b4', size: 16232 },
  { id: 's8a23dfae26', name: '洛琪希', file: '洛琪希.png', sha256: '43a550ae64ec6397bb35ed5b9b2bb8dded3ecad3f3dc131ff4cc8e2c4dc3e995', size: 1731310 },
  { id: 's8995615309', name: '派蒙', file: '派蒙.png', sha256: '732c0ff3cf30ee8ed8e1db353e57a0c1aff46b887571c96813184b8ae9a7c048', size: 1384411 },
  { id: 'sf16b3b9610', name: '流萤', file: '流萤.png', sha256: 'e10ce6d0cb3c22c327ee97307b218958769997c1d37f890207376aaed5250678', size: 2321656 },
  { id: 's80ac059dc2', name: '瓦雷莎', file: '瓦雷莎.png', sha256: '62898f0a9ca71ac454acb73881ec5a0de57c16845f93a55d90cda30798483e29', size: 332166 },
  { id: 'sd577294ef9', name: '睦子米', file: '睦子米.png', sha256: 'c88179f3cc6c21a90474f6028741f8e51b9f4ce37f427e50ca8eb0525f962497', size: 94725 },
  { id: 's78bbaca4aa', name: '绪山真寻-无稽之谈', file: '绪山真寻-无稽之谈.png', sha256: '37bcf282f05abc5bede83bdb4569a7f3087bb11831cc8f54451930ab89ab3640', size: 2737519 },
  { id: 's7303c1b0d5', name: '胡桃', file: '胡桃.png', sha256: '885b771c258187ff76e6fc28362759b874cfa7de28ddc40100f4bf305dfb71da', size: 325453 },
  { id: 'scb3c3b976a', name: '芙宁娜', file: '芙宁娜.png', sha256: 'f6f9c75f1f12f5ba22b98034ac37b8eea45fdc2271ca42a04fa24ea4ccff7b3c', size: 362245 },
  { id: 's5df9934040', name: '莉音', file: '莉音.png', sha256: '279a8a273633d849e424368e7b35512ad60a2587214af6cdbbc733c0e3aad456', size: 1106217 },
  { id: 's68d2d6025c', name: '薇薇安', file: '薇薇安.png', sha256: '028acd69124094458ec28fca27316a905ea7a9bd19f8fabc8ea45d08279fd318', size: 1475702 },
  { id: 's3fd9cc08f5', name: '诺亚', file: '诺亚.png', sha256: '7fb15622cafab9897d7e1fc7d8780ec91dcffacf68f8fe8054483b76681e694b', size: 2321133 },
  { id: 's16f0b0311b', name: '远坂凛', file: '远坂凛.png', sha256: '5c7d58c675aa6883774d295784f447635b251ad642658cabfcef3e04531f4682', size: 1359317 },
  { id: 's34330e4aba', name: '钟离', file: '钟离.png', sha256: 'a7debabad97173ab355a43d5bb24e2ee5f6fc9f9633efc3f83988e5e1973dc3e', size: 271666 },
  { id: 's762accf9cc', name: '阿篱（戈薇）', file: '阿篱（戈薇）.png', sha256: 'b7aef8c9409ccbec91da7fe6fd90756e64a3d80917fb73ef728632f19c873284', size: 1405052 },
  { id: 'se981cc7b13', name: '鼠鼠-简', file: '鼠鼠-简.png', sha256: '4ea0f0b86ddb70ae5aa7d7a0f82d3e0aeb5259dce26330b551ace6fd31b1ba55', size: 2657767 },
]

// 共享音效清单：id → { name, ext, sha256, size }。name 即展示名（含中文原名），
// 落进 sounds 的 shared 槽位后以 name 为去重键（sounds.installBuiltin 同名覆盖）
const SHARED_SOUND_LIB = [
  { id: 'AUGHHH', name: 'AUGHHH', ext: 'mp3', sha256: '1d37a8f72b6a24f75037d78acf319cbf8234a4c9a2b999e34c78b6dae0a7e695', size: 45597 },
  { id: 'Brun', name: 'Brun', ext: 'mp3', sha256: 'f8515bd50e07dc3d04c394c95de89ecb0a0dc2fa4adeceea330d4956037a2c75', size: 19629 },
  { id: 'Ciallo', name: 'Ciallo～(∠・ω- )⌒☆__', ext: 'mp3', sha256: '89143e920ac1a60dad82ea3f19aa79311695ec2f4ca2a14f0d28b8e34c6fb082', size: 23960 },
  { id: 'OHHHHH', name: 'OHHHHH', ext: 'mp3', sha256: '36bc4a8b4e8f7064135949779de8485a81e04abeb81242ec5301257e858a217a', size: 300201 },
  { id: 'Villager_haggle1', name: 'Villager_haggle1', ext: 'ogg', sha256: 'dae35cc7b2f1851c00a7ceab6f086b49401be0cb2c10d09c7096f2331dd738e6', size: 7104 },
  { id: 'Villager_haggle2', name: 'Villager_haggle2', ext: 'ogg', sha256: '4211a4f7a1ba1a6b344739891b68c1bfcb8d211c5e807704725b639c464f7630', size: 6911 },
  { id: 'Villager_idle1', name: 'Villager_idle1', ext: 'ogg', sha256: '0f9370a25d4d3a1a23c7837c458597c7c340cb87e7e43d5c13496d1fcc84845d', size: 8605 },
  { id: 'Villager_idle2', name: 'Villager_idle2', ext: 'ogg', sha256: '9fc012a401ab532611cbccab4d0edb217a70dbe44493777423d2277062e448f6', size: 10948 },
  { id: 'Villager_idle3', name: 'Villager_idle3', ext: 'ogg', sha256: '740c58ac5be7823483421520c172e3c526bb0b62745a857c2019b4aa7b750ae0', size: 7106 },
  { id: 'Villager_no1', name: 'Villager_no1', ext: 'ogg', sha256: '694d49fb97864b5aeb5500de68db1d1ff0ad9e709496f8e9e98e09892d5f24ea', size: 7715 },
  { id: 'Villager_no2', name: 'Villager_no2', ext: 'ogg', sha256: '9b3d41268ec72a50fa0fb242e4d25e98c85ff20613e3890dcca09e5dcc921b0e', size: 7051 },
  { id: 'Villager_no3', name: 'Villager_no3', ext: 'ogg', sha256: '7dece8b4532796494eae8502310faff11e36e63b4eb9d099598e4038b6bef371', size: 8697 },
  { id: 'Villager_yes1', name: 'Villager_yes1', ext: 'ogg', sha256: '53308b3a471f6b95c19f4088b5d92210bcb52d592d0ca3ba2bcee6f8659a4d85', size: 9191 },
  { id: 'Villager_yes2', name: 'Villager_yes2', ext: 'ogg', sha256: '4e570de3ba9e54b86dfafbff045ea2c50ab8dbe0fd4381f5cf7134732c99dc87', size: 11025 },
  { id: 'Villager_yes3', name: 'Villager_yes3', ext: 'ogg', sha256: '22f0f4401ccf59d78d84349c2410647d9d68878af5abfb20641d1524a31f8737', size: 6712 },
  { id: 'a7d18ec27b2', name: '[东北]我踏马来啦', ext: 'mp3', sha256: '51d87282b49cd27ca4bc34734d87e7d3ebeb713264357a82665fff68518cd716', size: 21596 },
  { id: 'a9edcb2e996', name: '[卢本伟]你好', ext: 'mp3', sha256: '0689f544bfac1c2b6e802b16f14ceae404ab0471edf060bb4fa46462a85c395b', size: 36615 },
  { id: 'hun', name: 'hun', ext: 'mp3', sha256: 'fa8898dee326db11e59130842e43a3b2dedff8a2527c68f52a972fed9e949231', size: 18141 },
  { id: 'oi', name: 'oi', ext: 'mp3', sha256: 'd82a32e07e2f6ad784c92b95b2aac5e264225c53989fcfc59899ea07305172c2', size: 8021 },
  { id: 'ok', name: 'ok', ext: 'mp3', sha256: '1e6def73cf725a96e263bec7f7e9deb09f4a1860d535ddebbf549160f70fdb45', size: 17468 },
  { id: 'pet', name: 'pet', ext: 'mp3', sha256: '94ece44fef8a67ee91432f600d47cf7c54e34f7c51e8800c961207c65dc6b99a', size: 7439 },
  { id: 'a2846cc8ab1', name: '乌拉', ext: 'mp3', sha256: '45fb0d585324f8067b9cfb28bb1909e47854bebba08c36c706e46e9737408327', size: 15696 },
  { id: 'afdc8c9c361', name: '乌拉乌拉', ext: 'mp3', sha256: '066f5e93758ea6ef241ec755e96dbd7491ff9ee91fd7acf0d49ae364e0d98f87', size: 39888 },
  { id: 'aigei_com', name: '全体目光向我看齐_爱给网_aigei_com', ext: 'mp3', sha256: '9b788fac9f9db05a73ed4c155acd09183b457e8a7ac5802aac15fab46d8d4a35', size: 45600 },
  { id: 'a51c4f9dddc', name: '哦买噶', ext: 'mp3', sha256: '7cebf286df910ec2fe079373904ccb00a6a74b860d94742677a2afdc81fd682c', size: 37869 },
  { id: 'aeb2a6376cc', name: '嗨嗨嗨', ext: 'mp3', sha256: '87d965b6a9a1fa39470c8f5e6d5182a1ef517e78871ef29dfc121eb377ee3fe6', size: 15260 },
  { id: 'a84609a0233', name: '嘟嘟到嘟嘟哒', ext: 'mp3', sha256: 'a929bc6699a9d4bd7c490f6009f9a880215780e4962cca7508030a1306d25a2b', size: 67532 },
  { id: 'acc2ffea242', name: '嘿嘿来了奥', ext: 'mp3', sha256: 'e1137e947f2ec7410c27c9277848580768ef2effa05a2a7d15abd8974596197c', size: 22988 },
  { id: 'a97b155934d', name: '屁', ext: 'mp3', sha256: 'c2b1def5e9f2dd5bde3f4b28f318667acc77113f279415dd5cab7b049ba86fb0', size: 26205 },
  { id: 'a8dccc4a2e6', name: '帽子', ext: 'mp3', sha256: '16730a5eb2dd38190af5bed3dc77f7933a022612e4515c698bb0cb846cef215b', size: 818719 },
  { id: 'a0c81d91501', name: '拆包', ext: 'mp3', sha256: '6cab828b34ecc01b69d4f1bbbba7e142df71bdc1781abe8595902ecaa4019857', size: 25834 },
  { id: 'out', name: '曼巴out_', ext: 'mp3', sha256: '90a003495a5b414928915fcf8522bc60b442da14ad891e6ec7aefe1d98b90f45', size: 151067 },
  { id: 'aaa0726dc04', name: '村民蜘蛛侠', ext: 'mp3', sha256: '84f63ceb6a7bf878c8e008323cb0e3461c90de52c298d6a206c6709ecd36ffbe', size: 49108 },
  { id: 'a4b1d6193e4', name: '来', ext: 'mp3', sha256: 'a6a238e2f95088a7d13bdc61af327caf056826bbd0838007e3192ad5edc84daf', size: 8178 },
  { id: 'a88b25cca3c', name: '来财', ext: 'mp3', sha256: '794bbd15af5e5c4901cec6c29c5f6935e522876c30f7d433d0a08b4e8fbece09', size: 6416 },
  { id: 'a39384362f4', name: '泡泡1', ext: 'mp3', sha256: 'ea5861548d0b02d8e49a17c65ee2b739789ec49c40737a77525ba75375b3c3d5', size: 8848 },
  { id: 'a82bdf97bbb', name: '泡泡2', ext: 'mp3', sha256: '96c7c989f017d13c302549968c7a7dd5e1d2d11ced96d57137fa0db5af9c8f78', size: 15922 },
  { id: 'a7eb42c557c', name: '疯狂星期四', ext: 'mp3', sha256: '2a581421e0dad8cb49210b71ca0bfd5f6fcde9945bf29eeae6a17a133809320c', size: 161763 },
  { id: 'a60dfddda86', name: '痞老板', ext: 'mp3', sha256: 'ef689a15b4a4f4834257ba9b423ad94f5c5591d984f9569848c35df0b705a33a', size: 114611 },
  { id: 'a0f0dcba268', name: '粑粑哦哦哦', ext: 'mp3', sha256: 'b03657f2ebd88e7cefac9ae7a2333b500fb80ebc02f3a1b292c3f69931ee8b91', size: 38074 },
  { id: 'a5925104df0', name: '罐头笑声', ext: 'mp3', sha256: '0ce6c7c73428d547d402f26a53b97b20cace60acd7ecc9e4f83fc140f04576a4', size: 296412 },
  { id: 'a0b7127fa51', name: '蔡徐坤鸡叫', ext: 'mp3', sha256: '187bb048385dffeb4b12aec74d28bac458bdd493d2f0dcfbb4df38f0bfc57e29', size: 11570 },
  { id: 'a27b03bd2f4', name: '造它', ext: 'mp3', sha256: '56883e66f83a47c6b0c1d22366ad81066d04f2aebde437e7437b1f952658b748', size: 17948 },
  { id: 'a70fb76d0ee', name: '钢管落地', ext: 'mp3', sha256: '012fc9bc264d3bcd79490cb0a0d2ec4f5a3dc243e6a7b63eb3f1d34209d55ff1', size: 186023 },
  { id: 'a65455d5584', name: '飞起来', ext: 'mp3', sha256: '21de2e9251f972655f62d5d0793b7712a1f747cef74e5257ebd885c8fb458757', size: 11900 },
]

// 可下载形象的清单：id → { name, file, sha256, size }。
// id 沿用图片文件名主干（与原来的内置形象 id 一致，用户升级后认的还是同一个名字），
// name 是展示名（与 id 同值 —— 原先下拉里就显示 id）。
//
// v1.8.0 起从 12 张精简为 1 张：其余 11 张与「共享角色包」是同图重复（那批本是用户从
// QQ 群挑一部分转 webp 单独打包，原图同时也在共享角色包里整包分发），且内置版还是重压的
// 低质量 webp，故一律改由共享角色包提供，这里只留真正独有的 DSniang02。
// 已下载过旧 11 张的老用户不受影响：落盘文件留在自定义画廊，配置值走 LEGACY_BUILTIN_SKINS
// 兼容（见 store.js），清单删项只影响「是否还提示可下载」。
//
// sha256 是**单张图**的校验值（打包时逐张算，见 public/whale-pack/manifest.json）：
// 素材包整体校验用 SKIN_PACK_SHA256 兜底，逐张校验则是为了「包里某张坏了只跳过那张」。
//
// 这份清单同时是设置页与宿主的**唯一真源**：id 集合决定「哪些形象可下载」，
// 设置页另有一份字面量副本（跨文件副本没法消掉，见 check-shared.mjs）。
const SKIN_PACK_SKINS = [
  { id: 'DSniang02', file: 'DSniang02.webp', sha256: '05b7f40593299f085f66d6a88af53852ded23e94dd804499e8732cc4e60e45bd', size: 74578 },
]

// dsh 版本配置的哨兵值：dshVersion 存它表示「装版本列表里最高的那个（含 alpha/rc 等测试版）」，
// 而不是 npm 的 latest 标签（latest 只指向稳定发布）。宿主 store/dsh 与设置页都要认它，
// 设置页持有一份字面量副本（见 App.vue 的 NEWEST_VERSION），改这里要同步，check-shared 会校验。
const NEWEST_VERSION = 'newest'

// dsh Web UI 的默认监听端口。用户可在设置页「高级选项」里改（存配置键 dshPort）——
// 3080 落在 Windows/Hyper-V 的动态端口保留段里，被系统预留时 dsh 直接 bind 失败，
// 上游 `dsh web --port <n>` 支持换端口。宿主 store 与 dsh.js 都从这里取默认值，
// 设置页持有一份字面量副本（见 App.vue 的 DEFAULT_DSH_PORT），改这里要同步，check-shared 会校验。
const DSH_PORT_DEFAULT = 3080

const BASE_MIN = 122   // 挂件基准尺寸下限 px
const BASE_CAP = 250   // 视口相关基准上限 px
const BASE_MAX = 625   // 挂件基准尺寸硬上限 px
// 窗口在挂件本体「四周各」多出的透明留白 px（窗口边长 = 挂件本体 + 2×WIN_PAD）：
// 汉堡菜单要在按钮上/下方展开，窗口必须比挂件本体大，否则菜单会被窗口边缘裁掉；
// 四周都给留白，挂件贴屏幕上边时菜单才能改向下方展开（见 floating-page.js 的 positionMenu）。
// 留白区全透明，靠 setIgnoreMouseEvents 点击穿透。
// 必须与 floating.css 里的 --whale-pad 保持一致。
const WIN_PAD = 200

// DeepSeek CNY 价格（每百万 token）：[空闲时段价, 高峰时段价]
// 高峰：工作日 9:00–12:00、14:00–18:00（北京时间）；2026-08-23 起周末全天谷价
// 官方调价只改这里；「实时·令牌」模式的今日已用按本表换算（见 lib/pricing.js 的 priceFor）。
// 模型名按子串匹配，键的顺序即优先级，新名要写在同前缀的旧名之前。
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-flash': BASE_PRICE,               // 当前模型名（DeepSeek-V4.1-Flash）
  'deepseek-v4-flash': BASE_PRICE,            // 旧名，请求已由 V4.1-Flash 提供，仍按 Flash 价计费
  'deepseek-v4-flash-vision-exp': BASE_PRICE, // 同上
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
// = 北京时间 2026-08-23 00:00
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

// 中国法定节假日（含调休放假日）全天谷价：这些日子虽是周一至周五，官方也按谷价计费。
// 键为北京时间 YYYY-MM-DD。只列「实际放假」的日子 —— 调休上班的周末（补班日）本来就在周末分支里
// 被判成谷价，不影响；而放假当天落在工作日时才需要这张表来纠正。
// 注意：与 WEEKEND_VALLEY_FROM_SEC（周末谷价的生效点）无关，节假日表不分生效点、一直生效。
// 依据国务院办公厅 2026 年部分节假日安排（元旦 / 春节 / 清明 / 劳动 / 端午 / 中秋 + 国庆）。
// 官方次年安排通常在头一年 11 月前后公布，届时在此追加即可（跨年查不到就按普通工作日算，
// 只会把少数的放假工作日按峰价高估，不会少计）。
const CN_HOLIDAYS = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节（除夕 02-16 起）
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-21', '2026-02-22', '2026-02-23', '2026-02-24',
  // 清明
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07', '2026-10-08',
])

// 「实时·令牌」模式的自定义单价（可选，见设置页「用量与账本」）：按百万 token 填价，覆盖上面的内置价目表。
// 填的按谷价处理，峰价沿用官方规则（恰为谷价 2 倍）自动翻倍；币种选 USD 时按 rate（元/USD）换算成
// 人民币后再记账 —— 账本与挂件显示统一按人民币，不受填的是哪种币影响。
// models 是「按模型覆盖」的条目（{ name, hit, miss, out }，name 按子串匹配，与内置表同规则）：
// 命中的模型用它，没列出的仍走内置价目表；两种覆盖可分别使用，同时存在时按模型优先（见 lib/pricing.js）。
const TOKEN_PRICE_DEFAULT = { on: false, cur: 'CNY', rate: 7.2, hit: 0.02, miss: 1, out: 4, models: [] }
// 单价与汇率上限：防手滑多打几个 0 算出荒谬金额（正常单价都在个位/十位数）
const TOKEN_PRICE_MAX = 1000000
const TOKEN_RATE_MAX = 1000
// 「按模型覆盖」的条目数上限：够覆盖常见几档模型，也挡住整段粘贴
const TOKEN_PRICE_MODELS_MAX = 20

// ──────────────────────────────────────────────
// GitHub 加速（hosts 方案，见 lib/hosts.js）
// ──────────────────────────────────────────────
// 只挑日常访问 GitHub 的高频域名；域名表同时被 store.js（normIps 归一化）与
// hosts.js（写块 / 冲突扫描 / 刷新）引用，放常量避免两份清单漂移。
// 各域名都要单独做 DoH 解析 + 可达性探测（每域名多候选），列表越长开启越慢。
// 因此只保留「实际下载 / 拉取代码必经」的域名；下面这几个已移除，理由是访问频率极低：
//   education.github.com / resources.github.com / archiveprogram.github.com / githubapp.com
// / uploads.github.com —— 上传 release 资产才会用到，日常 clone / pull 不经过
// 移除后这些域名不再加速（退回系统 DNS），但也不会比不开启更糟。
const GH_DOMAINS = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'github.githubassets.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.global.ssl.fastly.net',
  'github.dev',
  'githubusercontent.com',
  'github.io',
  // gist 单独补上：之前遗漏。gist.github.com 是页面入口，
  // gist.githubusercontent.com 是 gist 内容（代码片段 / raw 文件）的实际落点，
  // 少了后者照样打不开 gist 内容；两个都要。源表（GitHub520）覆盖这两个域名。
  'gist.github.com',
  'gist.githubusercontent.com',
  // 非 GitHub 域名：GitHub520 源不覆盖，只能靠写入前探测（可达才写），可用设置页 IP 表手动加
  'huggingface.co',
  'hub.docker.com',
  'greasyfork.org',
]
// 一键刷新用的社区源（GitHub520 每日更新 hosts）；仅解析上面关心的域名
const GH520_HOSTS_URL = 'https://raw.hellogithub.com/hosts'


const K = {
  secrets: 'whale:secrets', // dbCryptoStorage：{ apiKey, platformToken, models }
  config: 'whale:config',   // dbStorage：挂件配置
  ledger: 'whale:ledger',   // dbStorage：本地账本
  win: 'whale:window',      // dbStorage：窗口锚点
  update: 'whale:update',   // dbStorage：上次检查更新结果缓存
  timer: 'whale:timer',     // dbStorage：计时状态（重建挂件后恢复）
  dshVersions: 'whale:dshVersions', // dbStorage：dsh 可用版本列表缓存（查询结果，重载后仍可选用）
  // dbStorage：dsh 版本「查过没有」的标记。与 dshVersions 分开存：列表可能为空（上游下架），
  // 但「查过」这件事决定界面是否还要自动重查、按钮是否还挂着
  dshVersionsQueried: 'whale:dshVersionsQueried',
  // dbStorage：dsh release 说明正文的持久缓存 { version, at, items: { <版本号>: <markdown> } }。
  // 只存「上游正文」这一层，不存聚合结果 —— 聚合随所选区间变，落库反而会出现「版本号是新的、说明还是旧的」。
  // 正文本身是不可变的（某个 tag 的 release notes 写完就不再改），所以跨会话复用恒安全，
  // 目的就是免掉每次展开都重下 380KB 全量、把 2~3s 的网络等待缩成 0（详见 dsh-notes.js 的 load）
  dshNotes: 'whale:dshNotes',
  sounds: 'whale:sounds',   // dbStorage：自定义音效元信息，六槽位 press/release/low/budget/peak/pass 各 {name,ext,at}|null
  skins: 'whale:skins',     // dbStorage：自定义挂件形象画廊 { items: [{ id, name, ext, at }], current: id }
  bubbles: 'whale:bubbles', // dbStorage：自定义气泡图片（点鲸鱼时随机显示一张）[{ id, name, ext, at }]
  models: 'whale:models',   // dbStorage：多厂商模型的运行时状态（余额/今日已用/额度，不进备份）
  codex: 'whale:codex',     // dbStorage：Codex 会话统计缓存（各文件 size/mtime + 聚合，不含凭据）
  dshUsage: 'whale:dshUsage', // dbStorage：dsh 用量统计缓存（会话缓存的 size/mtime + 解析结果，不含凭据）
  dshDiagnose: 'whale:dshDiagnose', // dbStorage：dsh 只读诊断结果缓存（60s TTL，纯派生数据，不进备份）
  dshDump: 'whale:dshDump',     // dbStorage：dsh 配置转储（五层分层 + 树 diff）缓存（60s TTL，纯派生数据，不进备份）
  dshMarket: 'whale:dshMarket', // dbStorage：插件市场目录的**离线兜底**副本（官方/镜像都挂时仍能看上次的目录）
  taskbar: 'whale:taskbar',   // dbStorage：任务栏方向/厚度探测结果（纯派生数据，不进备份；用于免去冷启动同步起 reg.exe）
}

// ──────────────────────────────────────────────
// 多厂商模型（余额 / 额度）
// ──────────────────────────────────────────────
// 最多可添加的模型数（含内置 DeepSeek）
const MODEL_MAX = 10
// 主显示模型默认值 = 内置 DeepSeek
const DEFAULT_MAIN_MODEL = 'deepseek'
// 币种显示前缀。余额一律按原币种展示，不做汇率换算。
// CNY 带一个空格、USD 不带，是为了和挂件原有的 DeepSeek 显示（¥ 12.34）保持一致；
// 挂件页面里有一份同内容的兜底副本（浮动页没有 require，读不到这里）。
const MODEL_MONEY_PREFIX = { CNY: '¥ ', USD: '$' }
// 新建模型时按币种给的预警阈值初值（元 / 美元）
const LOW_ALERT_BY_CURRENCY = { CNY: 10, USD: 2 }
// 认证方式：'bearer' → Authorization: Bearer {key}；'raw' → Authorization: {key}（智谱那类不带 Bearer）
const MODEL_AUTHS = ['bearer', 'raw']
// 单次查询超时与「打开菜单后多久算过期」的懒加载间隔
const MODEL_FETCH_TIMEOUT_MS = 15000
const MODEL_STALE_MS = 5 * 60 * 1000
// 计时到点留言的长度上限。宿主清洗、菜单输入框 maxLength（floating-page.js 的 TIMER_NOTE_MAX）
// 与设置页输入框三处同值，改要一起改
const TIMER_NOTE_MAX = 60

// 内置厂商模板：选中后自动带好 URL / 认证 / 字段路径 / 币种，用户可再改。
// 只收录「能用 API key 直接查到余额或订阅额度」的厂商 —— 其余厂商官方没有这类接口，
// 而本插件拦不到对话事件、无法像 DSH 版那样按会话估算用量，搬过来只会是个空壳。
// kind='quota' 表示订阅额度（接口给的是窗口用量%，不是钱）；'balance' 表示余额（钱）；
// 'codex' 是本机 Codex 会话统计（读 ~/.codex 的会话日志，单位是 token，不查接口也不要密钥）。
// 字段路径支持 a.b[0].c 形式（数组段也可按字段挑条目：a[currency=CNY].b）；scale 是取到值之后的乘数（接口单位与展示单位不一致时用）。
const MODEL_TEMPLATES = {
  deepseek: {
    name: 'DeepSeek', kind: 'balance', currency: 'CNY', builtin: true,
    url: 'https://api.deepseek.com/user/balance', auth: 'bearer',
    // balance_infos 会同时给多种币种且顺序不固定，按 currency 挑，别写下标（取到美元余额不会报错）
    path: 'balance_infos[currency=CNY].total_balance',
  },
  openrouter: {
    name: 'OpenRouter', kind: 'balance', currency: 'USD',
    url: 'https://openrouter.ai/api/v1/credits', auth: 'bearer',
    // 该接口只给「总额度」和「已用」，余额得两者相减
    path: 'data.total_credits', usedPath: 'data.total_usage',
  },
  moonshot: {
    name: 'Kimi / Moonshot（CN）', kind: 'balance', currency: 'CNY',
    url: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'bearer',
    path: 'data.available_balance',
  },
  moonshot_intl: {
    // 国际站是独立账号体系（key 与大陆站不通用），余额按美元计
    name: 'Kimi / Moonshot（国际）', kind: 'balance', currency: 'USD',
    url: 'https://api.moonshot.ai/v1/users/me/balance', auth: 'bearer',
    path: 'data.available_balance',
  },
  stepfun: {
    name: '阶跃星辰 StepFun', kind: 'balance', currency: 'CNY',
    url: 'https://api.stepfun.com/v1/accounts', auth: 'bearer',
    path: 'balance',
  },
  novita: {
    name: 'Novita AI', kind: 'balance', currency: 'USD',
    url: 'https://api.novita.ai/v3/user/balance', auth: 'bearer',
    // 接口返回的金额单位是 0.0001 美元
    path: 'availableBalance', scale: 0.0001,
  },
  zhipu_glm_coding: {
    name: '智谱 GLM Coding（订阅）', kind: 'quota', currency: 'CNY',
    url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    auth: 'raw', // 智谱此接口不带 Bearer
    usedPctPath: 'data.limits[0].TOKENS_LIMIT.percentage',
    resetPath: 'data.limits[0].nextResetTime',
  },
  kimi_coding: {
    name: 'Kimi Coding（订阅）', kind: 'quota', currency: 'CNY',
    url: 'https://api.kimi.com/coding/v1/usages', auth: 'bearer',
    // 接口给的是「剩余量 + 总量」，已用百分比由两者算出
    remainPath: 'usage.remaining', totalPath: 'usage.limit', resetPath: 'usage.resetTime',
  },
  minimax_coding: {
    name: 'MiniMax Coding（订阅）', kind: 'quota', currency: 'CNY',
    url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', auth: 'bearer',
    // 接口一次给 5h 与周两个窗口，走多窗口路径（见 api.js parseModelQuota）
    windows: [
      { key: 'interval', label: '5h', remainPctPath: 'model_remains[0].current_interval_remaining_percent', resetPath: 'model_remains[0].end_time' },
      { key: 'weekly', label: '周', remainPctPath: 'model_remains[0].current_weekly_remaining_percent' },
    ],
  },
  minimax_coding_intl: {
    // 国际站是独立账号体系（key 与大陆站不通用），余额按美元计
    name: 'MiniMax Coding（国际）', kind: 'quota', currency: 'USD',
    url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains', auth: 'bearer',
    windows: [
      { key: 'interval', label: '5h', remainPctPath: 'model_remains[0].current_interval_remaining_percent', resetPath: 'model_remains[0].end_time' },
      { key: 'weekly', label: '周', remainPctPath: 'model_remains[0].current_weekly_remaining_percent' },
    ],
  },
  opencode_go: {
    name: 'OpenCode Go（订阅）', kind: 'quota', currency: 'USD',
    // 鉴权只需 Authorization: Bearer <key>（2026-09 实测：x-api-key 单独使用返回 401）
    url: 'https://opencode.ai/zen/go/v1/usage', auth: 'bearer',
    // 一次返回 rolling / weekly / monthly 三个窗口，值都是「已用百分比 + 重置时刻」
    windows: [
      { key: 'rolling', label: '5h', usedPctPath: 'usage.rolling.percent', resetPath: 'usage.rolling.resetsAt' },
      { key: 'weekly', label: '周', usedPctPath: 'usage.weekly.percent', resetPath: 'usage.weekly.resetsAt' },
      { key: 'monthly', label: '月', usedPctPath: 'usage.monthly.percent', resetPath: 'usage.monthly.resetsAt' },
    ],
  },
  zhipu_glm_coding_intl: {
    // 与国内站同构，只是域名不同、按美元计；鉴权同样不带 Bearer
    name: '智谱 GLM Coding（国际 z.ai）', kind: 'quota', currency: 'USD',
    url: 'https://api.z.ai/api/monitor/usage/quota/limit', auth: 'raw',
    usedPctPath: 'data.limits[0].TOKENS_LIMIT.percentage',
    resetPath: 'data.limits[0].nextResetTime',
  },
  codex: {
    // 本机 Codex 会话统计：不查接口、也不要密钥，读 ~/.codex 下的会话日志（见 lib/codex.js）。
    // 挂件把它当「余额」那一栏用，只是单位换成 token
    name: 'Codex（本地会话）', kind: 'codex', currency: 'USD',
  },
  openai_compat: {
    name: 'OpenAI 兼容中转站', kind: 'balance', currency: 'USD', needsBaseUrl: true,
    // OneAPI / New API 一类网关的经典账单接口：额度（美元）+ 已用（美分）
    url: '{base}/v1/dashboard/billing/subscription', auth: 'bearer',
    path: 'hard_limit_usd',
    usedUrl: '{base}/v1/dashboard/billing/usage', usedPath: 'total_usage', usedScale: 0.01,
  },
  custom: {
    // 兜底项：URL 与字段路径全部手填
    name: '自定义 HTTP', kind: 'balance', currency: 'CNY',
    url: '', auth: 'bearer', path: '',
  },
}

module.exports = {
  BALANCE_URL,
  USAGE_URL,
  BALANCE_TTL_MS,
  FETCH_TIMEOUT_MS,
  UPDATE_CHECK_URL,
  PLUGIN_VERSION,
  UPDATE_TTL_MS,
  MIN_SCALE,
  MAX_SCALE,
  SKIN_PACK_URL,
  SKIN_PACK_ORIGIN,
  SKIN_PACK_DEFAULT_PREFIX,
  SKIN_PACK_RAW_MAIN,
  SKIN_PACK_PREFIX_MAX,
  SKIN_PACK_SHA256,
  SKIN_PACK_TIMEOUT_MS,
  SKIN_PACK_MAX_BYTES,
  SKIN_PACK_SKINS,
  SHARED_RAW_BASE,
  SHARED_PACK_DEFAULT_PREFIX,
  SHARED_PACK_TIMEOUT_MS,
  SHARED_PACK_MAX_BYTES,
  SHARED_SKIN_PACK_SKINS,
  SHARED_SOUND_LIB,
  NEWEST_VERSION,
  DSH_PORT_DEFAULT,
  BASE_MIN,
  BASE_CAP,
  BASE_MAX,
  WIN_PAD,
  PEAK_HOURS,
  PRICING,
  WEEKEND_VALLEY_FROM_SEC,
  CN_HOLIDAYS,
  TOKEN_PRICE_DEFAULT,
  TOKEN_PRICE_MAX,
  TOKEN_RATE_MAX,
  TOKEN_PRICE_MODELS_MAX,
  GH_DOMAINS,
  GH520_HOSTS_URL,
  K,
  MODEL_MAX,
  DEFAULT_MAIN_MODEL,
  MODEL_MONEY_PREFIX,
  LOW_ALERT_BY_CURRENCY,
  MODEL_AUTHS,
  MODEL_FETCH_TIMEOUT_MS,
  MODEL_STALE_MS,
  TIMER_NOTE_MAX,
  MODEL_TEMPLATES,
}
