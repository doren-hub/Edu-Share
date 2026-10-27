import type { Locator, Page } from "playwright";
import {
  FLASHCARD_CARD,
  STUDIO_RELATIVE_TIME,
  isExplainerVideoCardText,
  isSlideDeckCardText,
  isSlideGenerationInProgress,
  isVideoGenerationInProgress,
  studioKindFromIcon,
} from "./studio-cards.ts";

export type StudioCardKind = "quiz" | "flashcards" | "slides" | "video" | "other" | null;
export type StudioArtifactKind = "quiz" | "flashcards" | "slides";
export type StudioArtifactCard = {
  text: string;
  kind: StudioCardKind;
  ready: boolean;
  busy: boolean;
  target: Locator;
};

/** Scope every lookup to an artifact row: source rows and creation tiles are not outputs. */
export async function studioArtifactCards(page: Page): Promise<StudioArtifactCard[]> {
  const modern = page.locator("artifact-library-item");
  const modernCount = await modern.count().catch(() => 0);
  const isModern = modernCount > 0;
  const rows = isModern ? modern : page.locator(".artifact-item-button, [data-artifact-id]");
  const count = isModern ? modernCount : await rows.count().catch(() => 0);
  const cards: StudioArtifactCard[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const visible = await row.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!visible) continue;
    const raw = (await row.innerText({ timeout: 2_000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    if (!raw) continue;
    const iconNode = row.locator(".artifact-icon");
    const iconCount = await iconNode.count().catch(() => 0);
    const icon = iconCount > 0 ? ((await iconNode.first().textContent({ timeout: 1_000 }).catch(() => ""))?.trim() ?? "") : "";
    const kind: StudioCardKind = icon
      ? (studioKindFromIcon(icon) ?? "other")
      : isModern
        ? "other"
        : studioKindFromIcon(raw.split(" ")[0]);
    const text = icon && !raw.startsWith(`${icon} `) ? `${icon} ${raw}` : raw;
    const buttons = row.locator("button.artifact-stretched-button, button[aria-labelledby^='artifact-labels-']");
    const syncIcons = await row.locator("mat-icon, .google-symbols, .material-symbols-outlined").allTextContents().catch(() => []);
    const busy = syncIcons.some(value => value.trim() === "sync");
    const buttonCount = await buttons.count().catch(() => 0);
    const target = buttonCount === 1 ? buttons.first() : row;
    const ready = (!isModern || buttonCount === 1) && buttonCount < 2 && STUDIO_RELATIVE_TIME.test(raw) && !busy;
    cards.push({
      text,
      kind,
      ready,
      busy,
      target,
    });
  }
  return cards;
}

function matchesKind(card: StudioArtifactCard, kind: StudioArtifactKind | "video"): boolean {
  if (card.kind !== null) return card.kind === kind;
  if (kind === "quiz") return /クイズ|\bQuiz\b/i.test(card.text);
  if (kind === "flashcards") return FLASHCARD_CARD.test(card.text);
  if (kind === "video") {
    return (
      isExplainerVideoCardText(card.text) ||
      isVideoGenerationInProgress(card.text) ||
      (/動画解説|Video overview|解説動画/i.test(card.text) && card.busy)
    );
  }
  return (
    /スライド資料|Slide deck|スライドデッキ/i.test(card.text) &&
    (isSlideDeckCardText(card.text) || isSlideGenerationInProgress(card.text))
  );
}

/** Returns true if a card for the given kind exists, including cards currently generating/syncing. */
export async function hasStudioArtifact(page: Page, kind: StudioArtifactKind): Promise<boolean> {
  return (await studioArtifactCards(page)).some(card => matchesKind(card, kind));
}

/** Returns true if a card for the given kind exists and is currently syncing/busy. */
export async function hasBusyStudioArtifact(
  page: Page,
  kind: StudioArtifactKind | "video",
): Promise<boolean> {
  return (await studioArtifactCards(page)).some(card => matchesKind(card, kind) && card.busy);
}

/** Returns true if a card for the given kind exists and is still generating (syncing or undated). */
export async function hasInProgressStudioArtifact(
  page: Page,
  kind: StudioArtifactKind | "video",
): Promise<boolean> {
  return (await studioArtifactCards(page)).some(
    card => matchesKind(card, kind) && (card.busy || !card.ready),
  );
}

/** Returns true if a card for the given kind exists and is completed and ready to open. */
export async function hasReadyStudioArtifact(page: Page, kind: StudioArtifactKind): Promise<boolean> {
  return (await studioArtifactCards(page)).some(card => matchesKind(card, kind) && card.ready);
}

export async function openStudioArtifact(page: Page, kind: StudioArtifactKind): Promise<boolean> {
  const card = (await studioArtifactCards(page)).find(card => matchesKind(card, kind) && card.ready);
  if (!card) return false;
  // The stretched button covers the title and timestamp; clicking either text can time out.
  await card.target.click({ timeout: 5_000 });
  return true;
}
