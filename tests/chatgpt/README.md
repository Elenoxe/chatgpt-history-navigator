# ChatGPT 只读兼容性测试

检查真实 ChatGPT 是否仍满足扩展依赖的 API、DOM、React 内部能力和内容格式。不加载扩展，不测试扩展自身 UI、缓存或合并逻辑，不发送消息、上传文件、修改设置或执行 materialize。

只检查生产代码实际消费或校验的字段；未使用的响应字段变化不影响结果。不做完整响应或 DOM 快照。

## 使用

需要 Node.js 22.18+。

```powershell
pnpm install
pnpm exec playwright install chromium
Copy-Item tests/chatgpt/config.example.json tests/chatgpt/config.local.json
pnpm test:chatgpt --login
```

在独立浏览器手动登录后，回终端按 Enter 保存并关闭。编辑 `config.local.json`，填写一个已有内容的测试专用会话 URL。

```powershell
pnpm test:chatgpt
pnpm test:chatgpt history.spec.ts
pnpm test:chatgpt --grep "Citation offsets"
```

没有会话 URL 时可以离线构建或列出测试，不会启动浏览器或访问 ChatGPT：

```powershell
pnpm test:chatgpt --build-only
pnpm test:chatgpt --list
```

登录状态保存在 `.chatgpt-compat/profile`，不使用日常浏览器 profile。不要同时运行登录和测试。
本地 JSON 配置和整个 `.chatgpt-compat/` 已被 gitignore；配置由 Zod 校验，未知字段报错。

## 文件职责

```text
tests/chatgpt/
├── specs/                 # 功能契约：history、page、navigation、content、files、writing
├── support/
│   ├── fixtures.ts        # Playwright fixture 与跳过处理
│   ├── request-gate.ts    # 串行请求、限速及跨 worker 预算
│   └── browser/           # 只在页面执行的适配器和共享操作
├── config.ts              # 本地配置读取与校验
├── config.example.json
├── playwright.config.ts
├── run.mjs
└── README.md
```

Playwright 只从 `specs/` 收集用例；spec 通过 `support/fixtures.ts` 使用共享能力，`support/` 不反向依赖 spec。资源读取场景显式设置 `test.use({ resourceReads: true })`，错误分类不依赖文件名。

| 文件                       | 职责                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `specs/history.spec.ts`    | session、mapping、首分页、上一页游标、原生 fetch 捕获              |
| `specs/page.spec.ts`       | bootstrap 身份、会话路由、滚动容器、turn ID、已观测到的目录        |
| `specs/navigation.spec.ts` | 原生虚拟列表方法、loader；未加载、未挂载、已挂载目标导航           |
| `specs/content.spec.ts`    | 消息 UUID、文本及多模态、引用和符号偏移、附件元数据                |
| `specs/files.spec.ts`      | 已存在的文件、library、sandbox、直接资源及项目/共享资源范围        |
| `specs/writing.spec.ts`    | 已有 Writing 块、版本元数据及正文读取                              |
| `support/fixtures.ts`      | worker 共享浏览器、准备页面数据、页面异常转为 Playwright 跳过      |
| `support/request-gate.ts`  | 请求队列、间隔、预算、停止条件；跨 worker 保存安全限制             |
| `support/browser/`         | 必须在页面执行的生产适配器、历史读取、原生导航、资源读取和网络观察 |
| `config.ts`                | 本地 JSON 的读取与校验                                             |
| `playwright.config.ts`     | Playwright 的并发、重试、期限和报告配置                            |
| `run.mjs`                  | 登录、构建浏览器 helper、转交 Playwright CLI                       |

每个 `test(...)` 是独立用例，没有检查注册表、编号、结果状态枚举或第二套报告器。可以按文件、标题或行号运行。
只有声明 `needsHistory: true` 的用例才准备 mapping 样本，不顺带读取分页接口。API 用例独立读取各自端点；成功和失败均在当前页面缓存，避免重复请求。分页测试不扩充其他用例的样本，单项与整套执行采用同一采样来源。
页面内的跳过原因通过异常传回 fixture，由原生 `test.skip` 和 annotations 展示。

不单独测试浏览器的 scrollIntoView、CSS color-scheme 或语言默认值；这些不能证明 ChatGPT 契约仍有效。输入框缺失时生产代码有明确布局回退，因此不要求它必定可见。Fiber 发现由实际原生方法检查覆盖，不重复扫描做第二项断言。
不设置固定跳过的写操作用例，也不把“识别到项目/共享路由”当成资源访问通过。实际项目/共享参数随文件读取验证；未出现对应文件时不声称覆盖。
生产代码会忽略编辑后失效的 citation marker，测试也不把这种样本判失败。Writing 正文按实际文件身份去重后抽样。

## 本地配置

| 字段                               | 含义                                                              |
| ---------------------------------- | ----------------------------------------------------------------- |
| `conversationUrl`                  | 已有普通、GPT 或项目会话的 /c/UUID URL，不支持新会话或 share 页面 |
| `intervalMs`                       | 前一个受控请求完成到下一个开始的间隔，至少 3000ms                 |
| `maxRequests`                      | 整轮受控请求上限，跨 worker 累计                                  |
| `maxPages`                         | 最多额外读取的历史页数                                            |
| `maxResources`                     | 每类最多读取的资源数                                              |
| `maxResponseBytes`                 | 主动 fetch 和被动历史捕获的响应大小上限                           |
| `requestTimeoutMs`                 | 单次读取期限                                                      |
| `pageTimeoutMs` / `readyTimeoutMs` | 页面导航及等待 main 区域的期限                                    |
| `actionTimeoutMs`                  | 原生导航及媒体加载期限                                            |
| `settleMs`                         | 页面打开后的初始化等待                                            |
| `suiteTimeoutMs`                   | Playwright globalTimeout，整轮测试总期限                          |

## 请求与运行边界

- 固定一个 worker、零重试，逐项运行；拒绝通过 CLI 开启多 worker 或重试。
- 浏览器路由串行放行已知 session、历史、文件 GET 和测试登记的资源请求，包含原生 loader 内部触发的历史 GET。
- 遇到 401/403/429、5xx、网络错误或读取预算耗尽，停止后续受控请求；不自动重试。保留可用的 Retry-After。
- Playwright 在失败后会重启 worker。新 worker 可能重新打开页面，但沿用整轮计数、上次完成时间和停止标记；上个 worker 在请求未完成时退出，会停止后续读取。
- 浏览器 context 阻止 Service Worker，使路由能够观察请求；不验证 Service Worker、扩展 isolated world、权限或 bridge。
- ChatGPT 自己的静态资源、遥测等其他流量不属于测试主动读取，不拦截其正常行为。
- 主动 API 调用限 HTTPS GET；mounted 文件需要 POST，不纳入只读用例。生产支持的 HTTP/mailto 附件链接只标记未验证，不误判为接口不兼容。
- 打开页面可能产生 ChatGPT 正常访问记录。图片和音视频通过浏览器元素验证加载，音视频只请求元数据；正文 fetch 有大小限制。

生产改动只导出已有的 findLoader / findNavigation。测试 bundle 复用生产 API、schema 和解析器，token 只在页面内存中使用。

## 结果与跳过

直接使用 Playwright 的 passed / failed / skipped 和退出码，不再提供自定义 PASS/FAIL 汇总或退出码 2。

- **失败**：观测到实际依赖不兼容，或测试自身执行出错。报告保留对应测试和异常，不能把所有失败都归因于 ChatGPT 更新。
- **跳过：不适用**：明确没有上一页，或只读范围不允许执行。
- **跳过：未观测到**：样本没有引用、Writing、资源或原生目录，不能推断该能力兼容。
- **跳过：受阻**：登录、权限、网络、前置数据或预算不足。文件 404 可能是过期或权限问题，不直接判接口变化。

每轮报告位于 `.chatgpt-compat/runs/<timestamp>/report/index.html`；`results.json` 是 Playwright 原生 JSON 报告，`network.json` 保存受控请求计数和停止信息。不另造结果文件格式。
不主动记录完整响应、token 或签名 URL，不启用截图和 trace。Playwright 原生失败诊断可能附带页面文本；报告含测试源码、错误及注释，仅存本地。

**退出码 0 仍可能有 skipped；查看跳过数量和原因，不能把未验证当作通过。**
结论仅覆盖本轮账号、会话和有界样本，不证明所有路由、历史或资源均兼容。不创建会话来补场景，不验证写操作、新生成格式、流式/WS 或设置切换。
没有真实登录和有效会话，只能验证测试工具，不能声明 ChatGPT 兼容性通过。
