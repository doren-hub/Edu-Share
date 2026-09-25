/**
 * R2 内。メイン PDF（{userId}/{testId}.pdf）と同じく先頭を uploaded_by に揃える。
 */
export function notebooklmSlidePdfStoragePath(uploadedBy: string, testId: string): string {
  return `${uploadedBy}/${testId}-notebooklm-slide.pdf`;
}

export function notebooklmVideoMp4StoragePath(uploadedBy: string, testId: string): string {
  return `${uploadedBy}/${testId}-notebooklm-video.mp4`;
}

/** 旧実装のパス（削除時の掃除用） */
export function legacyNotebooklmSlidePdfStoragePath(uploadedBy: string, testId: string): string {
  return `${uploadedBy}/${testId}/notebooklm-slide.pdf`;
}

export function legacyNotebooklmVideoMp4StoragePath(uploadedBy: string, testId: string): string {
  return `${uploadedBy}/${testId}/notebooklm-video.mp4`;
}
