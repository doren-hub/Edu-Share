import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import type { Processor } from "postcss";
import sharp from "sharp";

const require = createRequire(import.meta.url);

test("ES Modules 指定でも Next の TypeScript 設定を読み込める", async () => {
  // Use Next's config transpiler directly: loadConfig also reads .env files.
  const { transpileConfig } = require("next/dist/build/next-config-ts/transpile-config.js");
  const { default: config } = await transpileConfig({
    nextConfigPath: resolve("next.config.ts"),
    configFileName: "next.config.ts",
    cwd: process.cwd(),
  });

  assert.deepEqual(config.serverExternalPackages, ["pdf-parse"]);
  assert.equal(config.experimental.serverActions.bodySizeLimit, "200mb");
  assert.equal(config.experimental.middlewareClientMaxBodySize, "200mb");
});

test("Next の PostCSS ローダーでアプリの Tailwind CSS とソースマップを生成できる", async () => {
  // Exercise Next's actual loader/config discovery after overriding its pinned
  // PostCSS. This does not start Next or load application environment files.
  const { lazyPostCSS } = require("next/dist/build/webpack/config/blocks/css/index.js");
  const { postcssWithPlugins }: { postcssWithPlugins: Processor } =
    await lazyPostCSS(process.cwd(), undefined, undefined, undefined);
  const from = "src/app/globals.css";
  const css = await readFile(from, "utf8");
  const result = await postcssWithPlugins.process(css, {
    from,
    to: "globals.css",
    map: { inline: false, annotation: false },
  });

  assert.doesNotMatch(result.css, /@tailwind|@apply/);
  const bodyDeclarations: string[] = [];
  result.root.walkRules("body", (rule) => {
    rule.walkDecls((decl) => { bodyDeclarations.push(decl.prop); });
  });
  assert.ok(bodyDeclarations.includes("background-color"));
  assert.ok(bodyDeclarations.includes("color"));
  assert.ok(result.map);
  assert.ok(result.map.toJSON().sources.some((source) => source.endsWith("globals.css")));
});

test("更新した sharp でメモリ上の SVG を PNG に変換できる", async () => {
  const png = await sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="red"/></svg>',
  )).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 3);
});
