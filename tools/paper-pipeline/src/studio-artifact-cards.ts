import type { Locator, Page } from "playwright";
import { FLASHCARD_CARD, STUDIO_RELATIVE_TIME, isSlideDeckCardText, studioKindFromIcon } from "./studio-cards.ts";

export type StudioArtifactKind = "quiz" | "flashcards" | "slides";
export type StudioArtifactCard = { text: string; kind: string | null; ready: boolean; target: Locator };

/** Scope every lookup to an artifact row: source rows and creation tiles are not outputs. */
export async function studioArtifactCards(page: Page): Promise<StudioArtifactCard[]> {
  const modern = page.locator("artifact-library-item");
  const isModern = (await modern.count()) > 0;
  const rows = isModern ? modern : page.locator(".artifact-item-button, [data-artifact-id]");
  const cards: StudioArtifactCard[] = [];
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible())) continue;
    const raw = (await row.innerText()).replace(/\s+/g, " ").trim();
    const iconNode = row.locator(".artifact-icon");
    const icon = (await iconNode.count()) > 0 ? ((await iconNode.first().textContent())?.trim() ?? "") : "";
    const kind = icon ? (studioKindFromIcon(icon) ?? "other") : isModern ? "other" : studioKindFromIcon(raw.split(" ")[0]);
    const text = icon && !raw.startsWith(`${icon} `) ? `${icon} ${raw}` : raw;
    const buttons = row.locator("button.artifact-stretched-button, button[aria-labelledby^='artifact-labels-']");
    const busy = (await row.locator("mat-icon, .google-symbols, .material-symbols-outlined").allTextContents()).some(value => value.trim() === "sync");
    const buttonCount = await buttons.count();
    const target = buttonCount === 1 ? buttons.first() : row;
    cards.push({
      text, kind, target,
      ready: (!isModern || buttonCount === 1) && buttonCount < 2 && STUDIO_RELATIVE_TIME.test(raw) && !busy,
    });
  }
  return cards;
}

function matches(card: StudioArtifactCard, kind: StudioArtifactKind): boolean {
  if (!card.ready) return false;
  if (card.kind !== null) return card.kind === kind;
  if (kind === "quiz") return /クイズ|\bQuiz\b/i.test(card.text);
  if (kind === "flashcards") return FLASHCARD_CARD.test(card.text);
  return /スライド資料|Slide deck|スライドデッキ/i.test(card.text) && isSlideDeckCardText(card.text);
}

export async function hasStudioArtifact(page: Page, kind: StudioArtifactKind): Promise<boolean> {
  return (await studioArtifactCards(page)).some(card => matches(card, kind));
}

export async function openStudioArtifact(page: Page, kind: StudioArtifactKind): Promise<boolean> {
  const card = (await studioArtifactCards(page)).find(card => matches(card, kind));
  if (!card) return false;
  // The stretched button covers the title and timestamp; clicking either text can time out.
  await card.target.click({ timeout: 5_000 });
  return true;
}
