import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const postprocessOnly = process.argv.includes("--postprocess-only");
const args = process.argv
  .slice(2)
  .filter((arg) => arg !== "--postprocess-only");
const output = resolve(args[0] ?? "artifacts/storybook-project-detail-review");
// Explicit "initial" is reserved for debugging; default captures all 32 final cases.
const phase = args[1] ?? "final";
const cases = [
  ["01", "project-newprojectform--default"],
  ["02", "project-newprojectform--empty-source-hides-branch"],
  ["03", "project-newprojectform--create-error"],
  ["04", "project-cloneprogress--cloning"],
  ["05", "project-cloneprogress--slow"],
  ["06", "project-cloneprogress--failed-permission"],
  ["07", "project-cloneprogress--failed-not-found"],
  ["08", "project-cloneprogress--done"],
];
const initialNote =
  "debug-only：调试截图，不作为同状态验收（01 play 竞态／05 不同数据）；其他初始场景也未作同数据验收。";

async function capture() {
  const { chromium } = await import("../web/node_modules/playwright/index.mjs");
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  const records = [];
  for (const theme of ["dark", "light"])
    for (const width of [1440, 390]) {
      for (const [number, story] of cases) {
        if (number === "07" && phase === "initial") continue;
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
        });
        const draft = await context.newPage();
        const actual = await context.newPage();
        const id = `f-prj-create-${number}-${theme}-${width}-${phase}`;
        await draft.goto(
          `http://127.0.0.1:3001/gap/drafts/f-prj-create-${number}.html`,
        );
        // The draft frame is presentation chrome. Review the shipped dialog at the same viewport.
        await draft.evaluate((theme) => {
          document.documentElement.setAttribute("data-theme", theme);
          const frame = document.querySelector(".frame");
          if (frame)
            Object.assign(frame.style, {
              width: "100vw",
              height: "100vh",
              margin: "0",
              borderRadius: "0",
            });
          document.body.style.margin = "0";
          document.body.style.padding = "0";
        }, theme);
        await actual.goto(
          `http://127.0.0.1:6006/iframe.html?id=${story}&viewMode=story&globals=theme:${theme}`,
        );
        await actual.locator('[role="dialog"]').waitFor();
        await actual.waitForFunction(
          (theme) =>
            document.documentElement.classList.contains("dark") ===
            (theme === "dark"),
          theme,
        );
        if (number === "01")
          await actual.waitForFunction(
            () =>
              document.querySelector("input[name=project-name]")?.value ===
              "infra-scripts",
          );
        if (number <= "03") {
          await actual
            .getByLabel("项目名称", { exact: true })
            .fill(number === "03" ? "acme-web" : "infra-scripts");
          if (number === "03")
            await actual
              .getByLabel("仓库地址", { exact: true })
              .fill("https://github.com/acme/web.git");
          if (number === "01")
            await actual.getByLabel("仓库地址", { exact: true }).focus();
          else await actual.evaluate(() => document.activeElement?.blur());
        } else await actual.evaluate(() => document.activeElement?.blur());
        for (const page of [draft, actual])
          await page.evaluate(() => document.fonts.ready);
        const metrics = async (page, selector) =>
          page.locator(selector).evaluate((dialog) => {
            const rect = dialog.getBoundingClientRect();
            const computed = getComputedStyle(dialog);
            const fields = [
              ...dialog.querySelectorAll('input[type="text"]'),
            ].map((node) => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return {
                name: node.name,
                height: rect.height,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                left: rect.left - dialog.getBoundingClientRect().left,
                top: rect.top - dialog.getBoundingClientRect().top,
                shadow: style.boxShadow,
              };
            });
            return {
              width: rect.width,
              height: rect.height,
              border: computed.borderWidth,
              titleFont: getComputedStyle(dialog.querySelector("h2")).fontSize,
              fields,
              overflow: dialog.scrollWidth > dialog.clientWidth,
            };
          });
        const referenceFile = `${id}-draft.png`,
          actualFile = `${id}-storybook.png`;
        await draft
          .locator(".dialog")
          .screenshot({ path: `${output}/${referenceFile}` });
        await actual
          .locator('[role="dialog"]')
          .screenshot({ path: `${output}/${actualFile}` });
        const result = {
          id,
          theme,
          viewport: { width, height: 900 },
          draftUrl: draft.url(),
          storybookUrl: actual.url(),
          referenceFile,
          actualFile,
          reference: await metrics(draft, ".dialog"),
          actual: await metrics(actual, '[role="dialog"]'),
          purpose: phase === "initial" ? "debug-only" : "visual-review",
          sameExampleDataVerified: phase !== "initial",
          ...(phase === "initial" ? { alignmentNote: initialNote } : {}),
        };
        const left = (await readFile(`${output}/${referenceFile}`)).toString(
          "base64",
        );
        const right = (await readFile(`${output}/${actualFile}`)).toString(
          "base64",
        );
        const comparison = await context.newPage();
        await comparison.setViewportSize({
          width: Math.max(
            result.reference.width + result.actual.width + 64,
            720,
          ),
          height: Math.max(result.reference.height, result.actual.height) + 85,
        });
        const caption =
          phase === "initial"
            ? "Storybook · 调试截图 · 不作为同状态验收（01 play 竞态／05 不同数据）"
            : "Storybook · 同主题 / 视口 / 示例数据 · 保留像素差异";
        await comparison.setContent(
          `<html><body style="margin:0;background:${theme === "dark" ? "#171717" : "#eeeeee"};color:${theme === "dark" ? "#ededed" : "#171717"};font:14px system-ui"><div style="display:flex;align-items:flex-start;gap:24px;padding:20px"><div><p>设计稿 · ${id}</p><img style="display:block" src="data:image/png;base64,${left}"></div><div><p>${caption}</p><img style="display:block" src="data:image/png;base64,${right}"></div></div></body></html>`,
        );
        result.comparisonFile = `${id}-comparison.png`;
        await comparison.screenshot({
          path: `${output}/${result.comparisonFile}`,
          fullPage: true,
        });
        records.push(result);
        await context.close();
      }
    }
  await browser.close();
  await writeFile(
    `${output}/${phase}-comparison.json`,
    `${JSON.stringify({ purpose: phase === "initial" ? "debug-only" : "visual-review", captureValidity: phase === "initial" ? "debug-only" : "same-state-visual-review", method: phase === "initial" ? initialNote : "Real Storybook rendering versus imported static draft; identical Chrome, viewport, DPR1, theme and example data; reduced motion; draft frame chrome removed, component CSS preserved. No pixel-equivalence claim.", records }, null, 2)}\n`,
  );
  await renderGallery(records);
  console.log(
    JSON.stringify({
      phase,
      cases: records.length,
      output,
      heights: records.map((r) => ({
        id: r.id,
        draft: r.reference.height,
        storybook: r.actual.height,
        widthDifference: r.actual.width - r.reference.width,
      })),
    }),
  );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

async function renderGallery(records, pixels = []) {
  const byId = new Map(pixels.map((record) => [record.id, record]));
  const introduction =
    phase === "initial"
      ? initialNote
      : "左侧为设计稿，右侧为真实 Storybook。保留原始截图，按 RGB 最大通道差 > 12/255 统计差异；叠加图将 Storybook 以 50% alpha 覆盖原稿。尺寸相同不代表像素一致，这里不宣称像素等价。";
  const sections = records
    .map((record) => {
      const pixel = byId.get(record.id);
      const reference = pixel?.reference ?? record.reference;
      const actual = pixel?.actual ?? record.actual;
      const domDimensions = pixel
        ? `；捕获时 DOM：原稿 ${record.reference.width} × ${record.reference.height} px · Storybook ${record.actual.width} × ${record.actual.height} px`
        : "";
      const difference = pixel
        ? `原始 RGB 差异：${pixel.changedPixels.toLocaleString("en-US")} / ${pixel.totalPixels.toLocaleString("en-US")} 像素（${(pixel.changedFraction * 100).toFixed(2)}%），最大通道差 > 12/255。${pixel.dimensionsMatch ? "" : "尺寸不同，左上对齐且非共有区域计入差异。"}`
        : phase === "initial"
          ? initialNote
          : "尚未进行像素后处理，不能据此声称像素一致。";
      return `<section><h2>${escapeHtml(record.id)}</h2><p>原稿 PNG ${reference.width} × ${reference.height} px · Storybook PNG ${actual.width} × ${actual.height} px${domDimensions}</p><p>${escapeHtml(difference)}</p><p><a href="${escapeHtml(record.referenceFile)}">原稿 PNG</a> · <a href="${escapeHtml(record.actualFile)}">Storybook PNG</a>${pixel ? ` · <a href="${escapeHtml(pixel.overlayFile)}">50% alpha 叠加 PNG</a>` : ""} · <a href="${escapeHtml(record.storybookUrl)}">本地组件</a> · <a href="${escapeHtml(record.draftUrl)}">设计源稿</a></p><img loading="lazy" alt="原稿与 Storybook 并排对照" src="${escapeHtml(record.comparisonFile)}">${pixel ? `<details><summary>查看 50% alpha 叠加图</summary><img loading="lazy" alt="Storybook 以 50% alpha 覆盖原稿" src="${escapeHtml(pixel.overlayFile)}"></details>` : ""}</section>`;
    })
    .join("");
  await writeFile(
    `${output}/index.html`,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>新建项目 · Storybook 截图对照</title><style>body{font:14px system-ui;background:#171717;color:#ededed;padding:24px;line-height:1.6}a{color:#8dc5ff}section{margin:32px 0}img{display:block;max-width:100%;height:auto}h2{overflow-wrap:anywhere}</style><body><h1>新建项目 · Storybook 与设计稿截图对照</h1><p>${escapeHtml(introduction)}</p><p>${records.length} 组对照 · <a href="${escapeHtml(`${phase}-comparison.json`)}">捕获清单</a>${pixels.length > 0 ? ' · <a href="pixel-comparison.json">像素统计 JSON</a>' : ""}</p><p>终端相关对照：<a href="http://127.0.0.1:6006/?path=/story/terminal-terminaltabbar--with-tools-and-canvas&amp;globals=theme:dark">标签栏组件</a> · <a href="http://127.0.0.1:3003/terminal-termbar-draft-vs-storybook.png">终端原稿与 Storybook 对照图</a>（独立目录，不包含在项目弹窗像素统计中）</p>${sections}</body></html>`,
  );
}

async function markInitialDebugOnly(sharp) {
  const path = resolve(output, "initial-comparison.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  manifest.purpose = "debug-only";
  manifest.captureValidity = "debug-only";
  manifest.method = initialNote;
  manifest.records = manifest.records.map((record) => ({
    ...record,
    purpose: "debug-only",
    sameExampleDataVerified: false,
    alignmentNote: initialNote,
  }));
  // Re-compose presentation only from the original raw PNGs; never re-capture or alter metrics.
  for (const record of manifest.records) {
    const [reference, actual] = await Promise.all([
      sharp(resolve(output, record.referenceFile)).metadata(),
      sharp(resolve(output, record.actualFile)).metadata(),
    ]);
    const width = Math.max(reference.width + actual.width + 64, 720);
    const height = Math.max(reference.height, actual.height) + 100;
    const dark = record.theme === "dark";
    const background = dark ? "#171717" : "#eeeeee";
    const color = dark ? "#ededed" : "#171717";
    const heading = `<svg width="${width}" height="80" xmlns="http://www.w3.org/2000/svg"><g fill="${color}" font-family="sans-serif" font-size="14"><text x="20" y="22">调试截图 · 不作为同状态验收（01 play 竞态／05 不同数据）</text><text x="20" y="44" font-size="12">${escapeHtml(record.id)}</text><text x="20" y="68">设计稿 · 原始截图</text><text x="${reference.width + 44}" y="68">Storybook · 原始调试截图</text></g></svg>`;
    await sharp({ create: { width, height, channels: 4, background } })
      .composite([
        { input: Buffer.from(heading), left: 0, top: 0 },
        { input: resolve(output, record.referenceFile), left: 20, top: 80 },
        {
          input: resolve(output, record.actualFile),
          left: reference.width + 44,
          top: 80,
        },
      ])
      .png()
      .toFile(resolve(output, record.comparisonFile));
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function postprocess() {
  const { default: sharp } =
    await import("../web/node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js");
  const sourceManifestFile = `${phase}-comparison.json`;
  const manifest = JSON.parse(
    await readFile(resolve(output, sourceManifestFile), "utf8"),
  );
  if (
    !Array.isArray(manifest.records) ||
    (phase === "final" && manifest.records.length !== 32)
  )
    throw new Error(
      "Final pixel processing requires a completed manifest containing all 32 captures.",
    );
  const records = [];
  const channelThreshold = 12;
  for (const record of manifest.records) {
    const [reference, actual] = await Promise.all([
      sharp(resolve(output, record.referenceFile))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
      sharp(resolve(output, record.actualFile))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ]);
    if (reference.info.channels !== 3 || actual.info.channels !== 3)
      throw new Error(`${record.id}: RGB pixels required`);
    const width = Math.max(reference.info.width, actual.info.width);
    const height = Math.max(reference.info.height, actual.info.height);
    let changedPixels = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const inReference =
          x < reference.info.width && y < reference.info.height;
        const inActual = x < actual.info.width && y < actual.info.height;
        if (!inReference && !inActual) continue;
        if (!inReference || !inActual) {
          changedPixels++;
          continue;
        }
        const left = (y * reference.info.width + x) * 3;
        const right = (y * actual.info.width + x) * 3;
        const maximum = Math.max(
          Math.abs(reference.data[left] - actual.data[right]),
          Math.abs(reference.data[left + 1] - actual.data[right + 1]),
          Math.abs(reference.data[left + 2] - actual.data[right + 2]),
        );
        if (maximum > channelThreshold) changedPixels++;
      }
    const overlayFile = `${record.id}-overlay.png`;
    const rgba = await sharp(resolve(output, record.actualFile))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (rgba.info.channels !== 4)
      throw new Error(`${record.id}: RGBA overlay pixels required`);
    for (let offset = 3; offset < rgba.data.length; offset += 4)
      rgba.data[offset] = Math.round(rgba.data[offset] * 0.5);
    const translucentActual = await sharp(rgba.data, {
      raw: { width: rgba.info.width, height: rgba.info.height, channels: 4 },
    })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: resolve(output, record.referenceFile), left: 0, top: 0 },
        { input: translucentActual, left: 0, top: 0 },
      ])
      .png()
      .toFile(resolve(output, overlayFile));
    records.push({
      id: record.id,
      theme: record.theme,
      viewport: record.viewport,
      referenceFile: record.referenceFile,
      actualFile: record.actualFile,
      overlayFile,
      reference: { width: reference.info.width, height: reference.info.height },
      actual: { width: actual.info.width, height: actual.info.height },
      captureGeometry: {
        reference: {
          width: record.reference.width,
          height: record.reference.height,
        },
        actual: { width: record.actual.width, height: record.actual.height },
      },
      width,
      height,
      dimensionsMatch:
        reference.info.width === actual.info.width &&
        reference.info.height === actual.info.height,
      totalPixels: width * height,
      changedPixels,
      changedFraction: changedPixels / (width * height),
    });
  }
  const report = {
    phase,
    purpose: phase === "initial" ? "debug-only" : "diagnostic-pixel-comparison",
    sourceManifestFile,
    processedAt: new Date().toISOString(),
    method:
      "Decode original PNGs to RGB, without resize, registration, cropping or perceptual filtering. A pixel is changed when max(abs(RGB design - RGB Storybook)) > 12. Different sizes use the top-left aligned union canvas; non-shared pixels always count as changed. Overlay composites the original Storybook raster at 50% alpha over the original design raster. This is a diagnostic statistic, not a pixel-equivalence claim.",
    channelThreshold,
    normalizedThreshold: channelThreshold / 255,
    comparisonOperator: ">",
    overlayAlpha: 0.5,
    pixelEquivalenceClaim: false,
    records,
  };
  await writeFile(
    resolve(output, "pixel-comparison.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await markInitialDebugOnly(sharp);
  await renderGallery(manifest.records, records);
  console.log(
    JSON.stringify({
      phase,
      postprocessOnly,
      cases: records.length,
      output,
      dimensionMismatches: records
        .filter((record) => !record.dimensionsMatch)
        .map((record) => record.id),
      changedFractionRange: {
        minimum: Math.min(...records.map((record) => record.changedFraction)),
        maximum: Math.max(...records.map((record) => record.changedFraction)),
      },
      report: "pixel-comparison.json",
    }),
  );
}

if (postprocessOnly) await postprocess();
else {
  await capture();
  if (phase === "final") await postprocess();
}
