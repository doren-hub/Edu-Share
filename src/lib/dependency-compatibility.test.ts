import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import type { Processor } from "postcss";
import type sharpType from "sharp";

const require = createRequire(import.meta.url);

test("ES Modules 指定でも Next の TypeScript 設定を読み込める", async () => {
  // Use Next's config transpiler directly: loadConfig also reads .env files.
  // This internal API isolates config compatibility without reading secrets.
  // On Next upgrades, check its path/signature and keep these assertions.
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
  // lazyPostCSS is internal: a standalone PostCSS call would miss Next's plugin
  // discovery. On Next upgrades, check this path/signature against Next's loader
  // and adapt the call while preserving CSS and source-map assertions below.
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

test("更新した sharp でメモリ上の SVG を PNG に変換できる", async (t) => {
  // sharp is Next's optional transitive dependency. Local installs may omit it
  // or lack a supported native binary. CI must always exercise image conversion,
  // so a load failure there is an error rather than a silently skipped check.
  let sharp: typeof sharpType;
  try {
    sharp = require("sharp");
  } catch (error) {
    if (process.env.CI) throw error;
    t.skip(`optional sharp could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const png = await sharp(Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="red"/></svg>',
  )).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 3);
});
