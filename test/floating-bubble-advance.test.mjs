// test/floating-bubble-advance.test.mjs
// 按压气泡队列（bubble.on）的点击推进：点鲸鱼本体与点气泡都该往前走一步。
// 真机反馈「无法切换下一个气泡」，根因是点本体无条件把 bubbleIdx 归 0（见 showNormalBubble），
// 以及 render() 缺按队列当前页的兜底分支（内容被余额刷新顶回常规三行）。
// 这里按项目惯例钉住这几条接线，防止再回退。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')

test('点鲸鱼本体不重置气泡进度：已在放队列某一页时保留当前页', () => {
  assert.match(page, /if \(!bubbleActive \|\| bubbleIdx >= q\.length\) \{ bubbleIdx = 0; bubbleLastOptionIdx = -1; \}/)
  // 队列 = 倒计时页（开启时）+ 步骤（见 floating-pages.js）；未开启自定义时用出厂默认队列 dft
  assert.match(page, /var items = bubbleModelOn \? bubbleItems : \(bubbleDefaultItems\.length \? bubbleDefaultItems : bubbleItems\);/)
  assert.match(page, /return bubblePreviewItems \|\| PAGES\.queue\(\{ offworkOn: offworkOn, items: items \}\);/)
  // 仍是「末尾再点就收起」，推进本身不走这里
  assert.match(page, /function bubbleNext\(\) \{\s*var q = bubbleQueue\(\);\s*if \(bubbleIdx \+ 1 >= q\.length\) return false;\s*bubbleIdx \+= 1;/)
})

test('点气泡推进走 bubbleNext，末页才收起，停留时长按目标页布防', () => {
  assert.match(page, /if \(bubbleActive\) \{ if \(!bubbleNext\(\)\) hideBubble\(\); return; \}/)
  assert.match(page, /bubbleArm\(PAGES\.isCustom\(step\) \? bubbleModelDwellMs : bubbleDwellMs, hideBubble\); \/\/ 停留时长按目标页口径/)
})

test('render 兜底：队列当前页被顶掉时按这一页重画，倒计时页交给常规分支', () => {
  assert.match(page, /\} else if \(PAGES\.isCustom\(curPage\)\) \{/)
  assert.match(page, /if \(modsBox\.style\.display === 'none'\) bubbleRenderStep\(curPage\);/)
  // 倒计时页必须排除：否则 render → restoreBubbleLines → render 会无限递归
  assert.match(page, /if \(!PAGES\.isCustom\(step\)\) \{ restoreBubbleLines\(\); return; \}/)
})

test('单页时再点收起，不再静默重呈同一页', () => {
  // 真机反馈「切不到下一个气泡」：旧实现 else 分支 showBubble 重呈同一页、只续 5s TTL，看起来像点击完全没反应
  assert.match(page, /else if \(bubbleRemindActive\) \{/)
  assert.match(page, /else \{\s*hideBubble\(\); \/\/ 游离态兜底：内容只有一页时点一下收起/)
  // 旧的「首次点击：显示常规气泡内容」注释随该分支一起删掉，防止有人按旧语义改回去
  assert.doesNotMatch(page, /首次点击：显示常规气泡内容/)
})
