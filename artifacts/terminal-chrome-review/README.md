终端空白横栏修复的实际组件对照

`comparison-manifest.json` 记录截图来源、视口、主题、裁剪范围、DOM 尺寸和验证范围。

- 原稿：`http://127.0.0.1:3001/gap/drafts/f-wb-live-01.html`
- 实际组合 Storybook：`http://localhost:6006/?path=/story/terminal-terminaltabbar--with-tools-and-canvas&globals=theme:dark`
- 同一 1440×900 深色视口原稿：`draft-dark-1440-full.png`、`draft-dark-1440-termbar.png`、`draft-dark-1440-canvas.png`
- 同一视口最终组件：`story-after-dark-1440-full.png`、`story-after-dark-1440-termbar.png`、`story-after-dark-1440-canvas.png`
- 修复前实际生产的空白行：`production-before-dark-1440-topstrip.png`；源截图原样保留在 `../design-shell-project-v2-v3-dark1440/`。
- 1200×873 实际组件 before/after：`tabs-before.png` / `tabs-after.png`、`toolbar-before.png` / `toolbar-after.png`、`pane-before.png` / `pane-after.png`。

48 项共同组件 DOM 尺寸/颜色核对一致：栏 40px、标签 28px/14px、工具 28×28px、工具 gap 2px、两侧 16px、画布 12px 16px 内边距/无圆角/黑色。运行主区已去掉重复空白任务菜单行；页头对象菜单仍可查看锁定镜像并停止任务。复制、清屏、字号仍由活动会话提供，切换不重挂实例，关闭和宿主销毁后能恢复。

此处不声称整页逐像素相同。原稿带 32px 重连条与示例 Codex 输出；连接正常的组件骨架没有该条和模拟文本，分别比较共享终端栏和画布布局。修复前 Storybook 请求了深色，但当时主题未传递到全局背景，周边仍为亮色；保留真实 before，终端区域本身是黑色。画布 story 原先没有高度而塌缩，新预览提供 320px 展示区域，生产高度仍由任务页面决定。

实际验证：`acceptance.json`（真实页面/容器/HTTP，2/2），`stories-final.json`（4 个组件文件、20/20）；`stories.json` 保留一次增加错误断言导致的真实失败，后续更正为检查“新终端”而非合法关闭按钮。最早实现前失败另保存在 `../migration-audit/task-terminal-chrome-before-fix.log`。容器回归仅脚本化 xterm 引擎和外部 socket 边界，真实 PTY 的跨仓验证由主审计报告记录。相关源码 ESLint 和全量 typecheck 在 Node 22 下通过，root 另做最终完整门禁。
