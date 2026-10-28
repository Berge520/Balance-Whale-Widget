  - **⚠️ patch 文件路径踩坑（v1.6.2 修复，C2/C3 曾长期假通过）**：`cordis.patch.yml` 在 **`profiles/<n>/`** 下，不在 `$DSH_HOME` 根下。C2/C3 原写作 `path.join(home, 'cordis.patch.yml')` —— 少一层 `profiles/<n>`，恒 ENOENT，于是**恒报「无 cordis.patch.yml（未使用 patch，跳过）」并判 `[✓]`**，两个绿灯是假的。**更隐蔽的是测试与代码犯了同一个错**（测试把 patch 造在 `home` 根，正好对上错路径），双双通过 —— 直到实机里 C2/C3 说「无 patch」、转储卡却能读出 `profiles\web\cordis.patch.yml` 的条目才暴露。**判据**：同一函数下面读 `profiles/<n>/package.json` 用的就是正确路径，两处基准必须一致。已补单测：真实布局能读到、根目录那份不算、切 profile 读不同文件、C3 也走 `detect()`。
  - **⚠️ C2 判据踩坑（v1.6.2 修复，三次翻车后定为「采信 dsh 原话」）**：修掉上面的路径 bug 后，C2 立刻从「恒报无 patch」翻成 `[✗] 10 个 patch 条目对不上` —— **误报，本机 12 条 patch 里 11 条合法**。判据连翻三次车，都栽在同一个念头：**自己造一份「组装树里有哪些 id」的清单再比对**。
    - **第一次**：拿 `dependencies` 的包名。`- id:` 是**组装树里的注册 id**，与 npm 包名、bundles 名不是一个命名空间：

      | 命名空间 | 例子 |
      |---|---|
      | `dependencies` 的 npm 包名 | `dsh-mnemon`、`@liustack/modlens` |
      | `dsh.profile.bundles` 的挂载名 | `dsh-mnemon` |
      | patch 的 `- id:`（组装树注册 id） | `mnemon-bundle`、`mnemon-strategy-scoped`、`config-manager` |

      `mnemon-bundle` 这类**由 bundle 内部 insert 的 id** 一律对不上 → 10 个误报。
    - **第二次**：改成「上溯各 bundle 的 `dsh.bundle.patch` 声明文件，取其 `insert[].id` 当已知清单」。误报降到 2 个，但 `config-manager` 与 `webserver` **自带 `name:` 字段**，靠读 `node_modules` 找名字走不通：`profiles/web/node_modules` 是 **pnpm 布局**（`@deepseek-ai/` 目录不存在，依赖实体在 `.pnpm/`），bundle 的**传递依赖**在 profile 顶层读不到。
    - **第三次**：改成「拿 `--dump-config` 的 `entries` 当已知清单」。仍是 9 个对不上 —— 不是清单选错，是 **`entries` 本身不完整**：`mnemon-bundle` 的 `config:` 列表里**嵌套**了 8 个子条目（`mnemon`、`mnemon-source-*`、`mnemon-strategy-*`），而 `parseDump` 只认行首 `^- id:`，一个都没进 `entries`。真相是「11 条合法、只有 `config-manager` 真不存在」，这一版报 9 条（8 假阳性 + 1 真阳性）—— **靠巧合才没漏掉真错**。
    - **第四次定案：不再自己造任何清单，直接采信 dsh 自己打印的话。** `dsh --profile web --dump-config` 的输出**第一行**就是答案（走 stderr，`dsh-dump.js` 的 `run()` 本就把 stderr 一起收）：
      ```
      dsh: [C:\Users\Berge\.dsh\profiles\web\cordis.patch.yml] patch: entry "config-manager" not found
      ```
      新增 `dsh-dump.js` 的 `parseDshWarnings(text)` 抽出全部 not-found id（容忍 ANSI 颜色、同 id 去重），随 `collectDshDump` 结果写进缓存的新字段 `warnings`。C2 改调 `dshNotFoundIds(ctx)` 读它，**两档判据**：①拿到（`warnings` 是数组）→ dsh 报几条就报几条 `[✗]`，行号从 patch 文件里同 id 的位置补（dsh 只说 id、不说行号）；dsh 没报的 id 一条 finding 都不出；②拿不到（dsh 没装 / 没跑过转储 / 缓存 profile 不符 / **缓存里没有 `warnings` 字段**）→ `[!]`「无法判定 N 个 patch 条目（先跑一次配置转储）」。判据与 dsh 的行为**定义上一致**，不漏不误。`knownEntryIds` / `effectiveEntryIds` 均已删除。
    - **⚠️ 必须区分「拿不到」与「空数组」**：`warnings` 缺失时若当成 `[]`，等于宣称「dsh 没报任何 not found」，真错也会判成合法（**假通过**）；若把「没跑过」当成「树里什么都没有」，又会把合法条目全判成错（**误报**）—— 前一版判据正是在这两侧各栽过一次，故用 `null` 显式表达「不知道」。老缓存（v1.6.2 之前写的，没有 `warnings` 字段）一律按「拿不到」处理，提示用户重跑一次转储。
    - **由此确立的诊断设计原则**：**不能因「我这侧查不到」报 error** —— 误报会诱导用户去改本来正确的配置，比「少报」危害大得多。这条同样适用于 C1 / C5（D26「无法判定 = warning」）。单测钉住：`C2：拿不到 dump 时报 warning 提示，绝不报 error`、`C2：缓存里没有 warnings 字段（旧缓存）时按「拿不到」处理`、`C2：dsh 没报的 id 一律不出 finding`（12 条 patch、dsh 只报 1 条 → 断言恰好 1 条）；`parseDshWarnings` 另有纯函数测试（真实行 / 无警告 / 带 ANSI 且同 id 去重）。
    - **⚠️ 修完判据还得改提示口径**：判据改对了，`[✗]` 的 `hint` 却还写着「请核对拼写」—— 把「id 与树对不上」单一归因成用户拼错。实测反例：本机 8 个 `mnemon-*` **拼写全对**，真因是「该 id 由 `mnemon-bundle` 内部 insert、而 bundle 已不在 `dsh.profile.bundles` / 条目已改名」，用户照「核对拼写」改不出结果，还可能把对的 patch 改坏。现按三种真因给方向（① 由 bundle insert 而 bundle 没装；② 条目已改名 / 被上游移除；③ 才是拼写），并明确「先到『dsh 配置转储』的用户层列表对照该 id 是否还在；若无对应插件，删掉这条 patch 比改 id 更稳」。同一口径同步在设置页 `guide-use`「patch 条目」说明（[App.vue](file:///e:/Github/Balance-Whale-Widget/src/App.vue)）。单测 `C2：dsh 报 entry not found → error` 用两条 `assert.match` 钉住 hint 必须提到 `bundle` 与 `配置转储`。
    - **已修复**：`parseDump` 原先只认行首 `^- id:`，`config:` 列表里嵌套的子条目一个都收不进来。现改为**按缩进的条目栈**（`- id:` 正则放开缩进、任意深度都收），生效树、用户层 `mnemon-bundle`、base 层漏收的 `openviking-memory-runtime` 均已收全，`entriesWithKeys` 不变。**与 C2 判定无关**（C2 已改为采信 dsh 原话，不依赖 `entries`）。
    - **⚠⚠ 修复时踩到的第二个 bug：字段归属不能只看栈顶**。只认行首时漏收是「少了条目」，放开采纳嵌套后又暴露更隐蔽的错：原实现只在「下一个 `- id:` 到来时」才弹栈，于是父条目的**收尾字段**（缩进比子条目浅）会被错记到子条目头上。实测：`  disabled: false`(2) 覆盖掉子条目的 `disabled: true`(6)，且子条目后续的 `config:` 字段再也没机会被收。**归属必须按本行缩进再收一次栈**：本行缩进 `< 栈顶条目缩进 + 2` 时说明已退出该条目的字段区，逐层弹栈。用**严格小于**（条目自己的字段就在 `depth+2`，等于时必须保留栈顶）。缩进口径实测：`- id: X`(N) → `name` / `config:`(N+2) → config 顶层字段(N+4)。
    - **⚠ 又是「测试与实现共享同一个错误假设」的变体**：`configKeys` 的缩进门槛一度写成 `en.depth + 2`，四关全绿（既有用例只有顶层条目，写死 4 格也能过），但对嵌套条目 `entriesWithKeys` 直接掉到 0 —— 是拿真实 dump 核对数字才发现的。补单测钉住：嵌套子条目全部进 `entries`、`name`/`disabled`/`config` 按缩进归对层级（父条目收尾字段不得覆盖子条目）、`configKeys` 门槛随深度浮动（收 `embedding` 但不收 `embedding.enabled`）、`providers:` 里的 `- use:` / `instanceId:` 不得被当成条目。
