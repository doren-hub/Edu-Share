/** 出題・採点・テキスト生成で共通の Anthropic モデル設定。 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
}
