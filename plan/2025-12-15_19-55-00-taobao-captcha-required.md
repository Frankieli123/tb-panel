---
mode: plan
cwd: e:/APP/taobao
task: 登录后抓取价格触发 Captcha required（淘宝/阿里系风控）排查与改造计划
complexity: medium
tool: mcp__sequential-thinking__sequentialthinking
total_thoughts: 7
created_at: 2025-12-15T19:55:00+08:00
note: MCP sequential-thinking 在 IDE 内疑似卡住/被取消，本计划为不依赖 MCP 的可落地版本
---

# Plan: 登录后抓取价格触发 Captcha required 的排查与改造

## 任务概述
当前项目在账号完成登录并保存 Cookie 后，只要开始抓取商品价格，账号状态会被置为 `CAPTCHA`，并显示 `Captcha required`。
从项目代码看，这是在抓取页面时检测到阿里系滑块/行为验证（DOM 选择器 `#nc_1_n1z` / `.nc-container` 等）后触发的暂停逻辑。
目标是：明确触发风控的原因，降低触发概率，并在触发时提供可操作的处理路径（暂停、告警、人工验证/重新登录），保证抓价任务稳定运行。

## 背景判断（这是什么风控）
1. 这是阿里系常见的「行为验证/滑块验证」（业内常称 noCaptcha / NCCaptcha），用于反爬/反自动化。
2. 触发条件不是“抓价”这个业务本身，而是风控系统认为访问行为像机器人（例如：无头浏览器特征、指纹异常、访问频率、IP/地域异常、账号新号/风险、Cookie/登录态不一致、短时间大量打开页面等）。
3. 你的项目当前在 `server/src/services/scraper.ts` 用 Playwright **headless** 访问商品移动页，并在 `checkCaptcha()` 里用一组选择器判定是否出现滑块。
4. 一旦判定出现滑块，`server/src/services/scheduler.ts` 会把账号状态置为 `CAPTCHA` 并抛出 `Captcha required`，前端 `client/src/pages/Accounts.tsx` 显示出来。

## 执行计划

### Phase 1: 复现与证据采集（先把“为什么触发”落到数据）
1. 固化复现步骤：选择 1 个账号 + 1 个商品，手动触发抓取（`POST /products/:id/refresh`）并记录是否出现 `needCaptcha`。
2. 抓取时采集证据（建议先只加日志，不改行为）：
   - 访问 URL（最终落地 URL）、HTTP 响应状态（是否 302/403/429）、重定向链路。
   - 页面标题/关键文本：是否出现“访问受限”“请完成验证”“系统繁忙”等。
   - 触发验证码时截图与 HTML（只在 needCaptcha 时保存），用于确认是 nc 滑块还是别的拦截页。
   - 当前上下文 Cookie 数量、关键 Cookie 是否存在/是否过期（如 `_m_h5_tk`/`_m_h5_tk_enc` 等）。
3. 验证“登录态是否真的可用”：当前抓取逻辑只用 `checkNeedLogin()` 判断跳转登录页/提示“请登录”，但不验证接口级 token 是否有效。需要额外确认抓取页是否已被降级到游客态/风险态。

### Phase 2: 风控触发源定位（按优先级排查）
1. 频率与模式：
   - 虽然 worker concurrency=1，但调度循环每 10 秒会往队列里塞任务；每个商品抓取都会新建 `page` 并 `goto`，在一段时间内可能形成稳定的“机器节奏”。
   - 检查 `SCRAPER_MIN_INTERVAL_MS`/`MAX_INTERVAL_MS` 实际配置是否过小，是否与商品数量叠加导致总请求过密。
2. 浏览器特征：
   - 抓取使用 `headless: true`，即便注入 stealth 脚本，依然可能被检测（尤其是淘宝/天猫这类站点）。
   - 登录流程（`loginManager.ts`）是有头+桌面设备配置，而抓取是移动 UA+无头；这类“登录指纹”与“抓取指纹”不一致会增加风控概率。
3. 账号与环境：
   - 新号/刚登录/短时间大量访问更容易触发；同 IP 多账号也更容易触发。
   - 服务器 IP（机房）比住宅网络更容易触发。

### Phase 3: 短期止血（先让系统“可用且可恢复”）
1. 触发 `needCaptcha` 的账号：
   - 进入 `CAPTCHA` 状态后增加“冷却时间”，例如 N 分钟内不再分配任务；避免在验证页反复访问导致更高风险。
   - 通知：在通知渠道里新增“账号需验证”的告警（复用现有 notification service），让你能第一时间人工处理。
2. 限速策略（最有效的降触发手段之一）：
   - 增大 `SCRAPER_MIN_INTERVAL_MS / MAX_INTERVAL_MS` 的默认值，并让它区分：同账号最小间隔、全局最小间隔。
   - 对同一账号加“抖动”(jitter)，避免固定周期。
3. 失败重试策略调整：
   - 当前 bullmq `attempts: 3` + 1 分钟指数退避，遇到 CAPTCHA 其实不应自动重试；建议把 `Captcha required` 视为“需人工介入”的不可重试错误。

### Phase 4: 中期改造（降低触发概率的工程化方案）
1. 会话/指纹一致性：
   - 让“登录”和“抓取”尽量使用一致的设备配置（同 UA、同 viewport、同浏览器通道）。
   - 优先复用同一个 `BrowserContext`，避免频繁创建新 context；并减少每次任务新建页面带来的指纹波动。
2. 从“页面解析”向“更稳定的数据源”迁移（可选，但通常更稳）：
   - 若你抓取的只是价格，可评估是否存在更稳定的后端接口/JSON 数据（仍需登录态），避免渲染页触发滑块。
   - 注意：必须在合规与站点规则允许范围内进行；不做绕过验证码的实现。
3. 触发后的人机协同流程：
   - 增加“人工验证模式”：当账号进入 `CAPTCHA`，允许用户一键打开有头浏览器到触发页面完成滑块/验证，然后把新的 Cookie/StorageState 保存回去。
   - 现有 `loginManager.ts` 已支持 WebSocket 推送截图用于扫码登录，可复用同思路扩展为“验证处理”。

### Phase 5: 验证与回归
1. 定义指标：
   - 单账号每 100 次抓取触发验证码次数（Captcha Rate）。
   - 平均抓取成功率、平均耗时。
2. 回归清单：
   - 正常抓取价格不受影响。
   - 触发验证码后账号会暂停且能收到告警。
   - 人工处理后账号能恢复到 `IDLE` 并继续抓取。

## 风险与注意事项
- 合规风险：验证码/行为验证属于站点安全策略，建议把系统设计为“降低触发 + 触发后人工处理”，而不是自动绕过。
- 环境风险：机房 IP、多账号共用 IP、长期稳定的机器访问节奏都会显著提升触发概率。
- 技术风险：仅靠简单 stealth 脚本通常不足以对抗淘宝级别风控，工程上应把“可恢复”作为第一目标。

## 代码参考点（已定位）
- `server/src/services/scraper.ts`：`checkCaptcha()`（检测 `#nc_1_n1z` / `.nc-container` 等）
- `server/src/services/scheduler.ts`：遇到 `result.needCaptcha` 时写入 `lastError: 'Captcha required'` 并置 `AccountStatus.CAPTCHA`
- `client/src/pages/Accounts.tsx`：展示“上次登录/错误: Captcha required”
- `server/src/services/loginManager.ts`：有头登录、保存 cookie

## MCP 工具卡住的排障建议
- 如果你看到一直停在 “Ran with these arguments”，通常表示 MCP 调用未返回或被 IDE 取消。
- 你可以：
  1) 在 IDE 里点 Stop/Cancel 当前工具调用；
  2) 重启 MCP server（如果你的 Windsurf/IDE 提供对应按钮）；
  3) 或者继续采用本文件这种“无 MCP 依赖”的计划输出方式。
