---
mode: plan
cwd: e:/APP/taobao
task: 修复淘宝 PC 商品页价格抓取（消除 __name is not defined，并稳定提取到 ¥1.51）
complexity: medium
tool: manual
created_at: 2025-12-16T00:12:00+08:00
---

# Plan: 淘宝 PC 商品页价格抓取修复

## 目标（验收标准）
- 抓取 `https://item.taobao.com/item.htm?id=1001275636385` 时不再出现 `page.evaluate: ReferenceError: __name is not defined`。
- `extractPriceInfo()` 能稳定产出：
  - `finalPrice = 1.51`（允许轻微浮动但必须能解析出价格数值）
  - `title` 非空（至少为 `page.title()` 的清洗版本）
- 当 `finalPrice` 与 `originalPrice` 同时为空时，抓取任务应判定失败并保存 debug artifacts。
- `_debug/*.html` 用 `file://` 打开时不再因为 `//` 资源链接导致大量资源请求解析错误（打开速度明显改善，关键 DOM 可查看）。

## 背景与根因
- 在 `tsx` 开发运行时，`esbuild` 会在函数源码中注入 helper（常见为 `__name(...)`），而 Playwright 的 `page.evaluate(fn)` / `page.waitForFunction(fn)` 会把传入函数序列化后在浏览器隔离上下文执行。
- 该隔离上下文里没有 Node/tsx 注入的 `__name`，导致运行时报 `ReferenceError: __name is not defined`，进而中断价格提取。
- 之前尝试通过 `addInitScript` 注入 `__name` 仍可能无效（隔离世界/UtilityScript 不一定读取到页面全局变量），因此最稳妥方案是：**避免 evaluate(fn)/waitForFunction(fn) 这类“传函数”调用。**

## 当前已完成的修复（代码层）
- `server/src/services/scraper.ts`
  - 移除 `checkAccessDenied()` 内的 `page.evaluate(...)`，改为 `page.title()` + `locator('body').innerText()`。
  - 移除 `waitForPriceElement()` 内的 `waitForFunction(...)`，改为 `locator(selector).waitFor()` + `Promise.any()`。
  - 重写 `extractPriceInfo()`：不再 `page.evaluate(extract)`，改为 Playwright locator API 获取文本并解析价格。
  - 保存 debug HTML 时，将 `src/href="//..."` 和 `url(//...)` 归一化为 `https://...`，避免 `file://` 打开时解析成 `file://...`。
- `server/src/scripts/login.ts`
  - 移除 `page.evaluate(() => document.body.innerText...)`，改为 `locator('body').innerText()`。

## 待验证事项（你需要运行验证）
1. 启动服务端与前端（如果需要 UI 触发）
   - server: `npm run dev`
   - client: `npm run dev`
2. 触发抓取并观察日志（重点：是否还出现 `__name`）
   - 触发方式按你现有流程：Scheduler job / API refresh / UI 触发皆可
3. 检查结果：
   - Job 返回 `success=true` 且 `data.finalPrice` 为 `1.51`。
   - 若失败，应生成新的 debug artifacts，且 error 信息不再是 `__name`。

## 如果仍抓不到价格（Fallback 策略）
按风险从低到高：
1. **增加/调整 selector 覆盖面**（优先）
   - 保持当前 SSR 结构 selector：`.highlightPrice--LlVWiXXs .text--LP7Wf49z`
   - 若淘宝更换 hash class，考虑补充更稳定的语义定位：围绕“到手价/券后价/价格”文本的相邻节点（仍用 locator，不用 evaluate）。
2. **从 HTML 文本做兜底解析**（已做基础版本）
   - `page.content()` 中匹配 `¥` / `￥` 后的数值。
3. **需要更强数据源时再考虑**
   - 只有在合法合规前提下，评估是否存在更稳定的 JSON 数据（不实现验证码绕过）。

## Debug HTML 打开慢/空白的处理
- 已处理：保存时把协议相对 URL `//` 转为 `https://`。
- 若仍然“慢/空白”（通常是 CSR 依赖接口 + 本地 file 安全策略导致）：
  - 增加一个本地 HTTP 静态文件预览入口（例如在 server 里加 `GET /debug/:file` 直接 `sendFile`），用 `http://localhost:3001/...` 打开，而不是 `file://`。
  - 或生成一个“静态快照”：在保存 debug artifacts 时移除/禁用大体积脚本（但这会改变页面行为，谨慎）。

## 回归点
- 确认登录/验证码判断逻辑未被本次改动破坏：
  - `needLogin` / `needCaptcha` 分支仍能正常返回。
  - 失败时仍会保存 screenshot + html + json 元数据。

## 风险
- Locator 方式依赖页面 DOM 渲染完成度：在 CSR 极重的页面上，可能需要更长的等待或更稳的等待条件。
- 价格 className 可能频繁 hash 变动：需要准备更多 fallback selector 或语义定位策略。
