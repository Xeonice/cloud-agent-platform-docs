# 第三方资源与许可

试点稿件只用到下面两份第三方资源，全部本地化，不发任何网络请求。

| 资源 | 用在哪里 | 版本 / 来源 | 许可 |
|---|---|---|---|
| Geist、Geist Mono 可变字体 | `assets/fonts/Geist-Variable.woff2`（69,652 B）、`assets/fonts/GeistMono-Variable.woff2`（71,368 B）；由 `assets/tokens-v2.css` 的 `@font-face` 加载 | npm `geist@1.7.2`（vercel/geist-font）；从 `vercel-style/fonts/` 原样复制 | SIL Open Font License 1.1，原文见 `assets/fonts/LICENSE.txt` |
| lucide 图标 | `assets/components-v2.css` 文件尾的 `.i-*` CSS mask（由 `tools/build-icons.cjs` 生成） | `lucide-react@0.468.0`（只读取用 web 仓库 `node_modules` 里的图标路径数据；描边改为 1.5 + `vector-effect: non-scaling-stroke`，任何尺寸都是 1.5px） | ISC License，原文见下 |

文件校验（SHA-256）：

```
a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8  fonts/Geist-Variable.woff2
fba8f577f38a2bbcbe818efa6348dd58f36303a10b8737c42fefad275be563ab  fonts/GeistMono-Variable.woff2
```

## Geist / Geist Mono —— SIL Open Font License 1.1

> Copyright (c) 2023 Vercel, in collaboration with basement.studio
>
> This Font Software is licensed under the SIL Open Font License, Version 1.1.

- 许可全文随字体一起放在 `assets/fonts/LICENSE.txt`（逐字复制自上游，不要删改）。
- OFL 允许自由使用、嵌入与再分发字体文件；再分发时必须附带版权声明与许可全文；不能单独出售字体文件本身。
- Geist 没有声明保留字体名（Reserved Font Name），我们原样使用原文件，没有修改字形，也没有改名。
- 稿件里的字体名写作 `"Geist"` / `"Geist Mono"`；`@font-face` 里给 Geist 加了 `unicode-range`（排除 U+2014、U+2018–201D），这只是选择用字范围，不修改字体文件。

## lucide —— ISC License

图标的路径数据来自 lucide（lucide-react 0.468.0）。我们只取 SVG 路径，按 viewBox 24、stroke-width 2.25 重新拼成 data URI 作为 CSS mask；没有使用 Vercel / Geist 的图标。许可原文：

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

其中 Feather 部分的版权声明（MIT）随 lucide 的版权行一并保留，见上。

## 不使用的东西（简报 P12 护栏）

- 不用 Vercel 的 logo、Geist 图标、组件代码；Geist token 的数值只作参考（取值逐项写在 `research/tokens-v2-draft.json`）。
- 产品名、语义色（Q-DS-15 六态）和终端优先的布局保留我们自己的。
