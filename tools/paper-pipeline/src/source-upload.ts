import type { FileChooser, Locator, Page } from "playwright";

const UPLOAD_NAMES = [
  /パソコンから/, /コンピュータ/, /From computer/i, /デバイス/,
  /ファイルをアップロード/, /Upload file/i, /Choose file/i, /ファイルを選択/, /^PDF$/,
];

type UploadOptions = {
  searchTimeoutMs?: number;
  clickTimeoutMs?: number;
  chooserTimeoutMs?: number;
};

async function uploadRoot(page: Page): Promise<Locator> {
  const dialogs = page.locator('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane');
  for (let i = await dialogs.count() - 1; i >= 0; i--) {
    const dialog = dialogs.nth(i);
    if (await dialog.isVisible()) return dialog;
  }
  return page.locator("body");
}

/** Search has one deadline; chooser monitoring starts only after a usable target is found. */
export async function setSourcePdf(
  page: Page,
  pdfPath: string,
  options: UploadOptions = {},
): Promise<"input" | "chooser"> {
  const searchUntil = Date.now() + (options.searchTimeoutMs ?? 15_000);
  while (Date.now() < searchUntil) {
    const root = await uploadRoot(page);
    // Hidden file inputs are intentional, but never use an input behind a visible modal.
    const inputs = root.locator('input[type="file"]:not([disabled])');
    if (await inputs.count()) {
      await inputs.first().setInputFiles(pdfPath, { timeout: Math.max(1, searchUntil - Date.now()) });
      return "input";
    }
    // Prefer every named control before text fallback, so help text cannot beat a later button.
    const candidates = (["button", "link", "menuitem"] as const).flatMap(role =>
      UPLOAD_NAMES.map(name => root.getByRole(role, { name })),
    );
    candidates.push(...UPLOAD_NAMES.map(name =>
      root.locator("label, [onclick], [tabindex]").filter({ hasText: name }),
    ));
    for (const candidatesOfKind of candidates) {
      const count = await candidatesOfKind.count();
      for (let i = 0; i < count; i++) {
        const remaining = searchUntil - Date.now();
        if (remaining <= 0) break;
        const target = candidatesOfKind.nth(i);
        if (!(await target.isVisible()) || !(await target.isEnabled())) continue;
        const clickMs = Math.max(1, Math.min(options.clickTimeoutMs ?? 5_000, remaining));
        await chooseSourceFile(page, target, pdfPath, clickMs, options.chooserTimeoutMs ?? 15_000);
        return "chooser";
      }
    }
    const remaining = searchUntil - Date.now();
    if (remaining > 0) await page.waitForTimeout(Math.min(100, remaining));
  }
  throw new Error("ソース追加の file input / アップロードボタンが探索期限内に見つかりませんでした");
}

async function chooseSourceFile(
  page: Page, target: Locator, pdfPath: string, clickMs: number, chooserMs: number,
): Promise<void> {
  let resolveChooser!: (chooser: FileChooser | null) => void;
  const event = new Promise<FileChooser | null>(resolve => { resolveChooser = resolve; });
  const onChooser = (chooser: FileChooser) => resolveChooser(chooser);
  // The event budget includes the complete click budget. Missing name candidates spend none of it.
  const timer = setTimeout(() => resolveChooser(null), clickMs + chooserMs);
  page.once("filechooser", onChooser);
  try {
    try {
      await target.click({ timeout: clickMs });
    } catch {
      // If the click dispatched an event before failing, cancel that chooser without selecting a PDF.
      resolveChooser(null);
      const chooser = await event;
      if (chooser) await chooser.setFiles([], { timeout: chooserMs }).catch(() => undefined);
      throw new Error("ソース追加のアップロードボタンをクリックできませんでした");
    }
    const chooser = await event;
    if (!chooser) throw new Error("ソース追加ボタンのクリック後に filechooser が発生しませんでした");
    try {
      await chooser.setFiles(pdfPath, { timeout: chooserMs });
    } catch (error) {
      await chooser.setFiles([], { timeout: chooserMs }).catch(() => undefined);
      throw error;
    }
  } finally {
    clearTimeout(timer);
    page.off("filechooser", onChooser);
  }
}
