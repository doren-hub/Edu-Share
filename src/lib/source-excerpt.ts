/** 出題時に渡した結合テキスト内に、モデルが返した抜粋コピーが実在するか（空白正規化あり） */
export function excerptAppearsInJoined(excerpt: string, joined: string): boolean {
  const e = excerpt.replace(/\s+/g, " ").trim();
  if (e.length < 16) return false;
  const j = joined.replace(/\s+/g, " ");
  if (j.includes(e)) return true;
  return j.replace(/\s/g, "").includes(e.replace(/\s/g, ""));
}
