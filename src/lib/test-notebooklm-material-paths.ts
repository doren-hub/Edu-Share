/**
 * pdfs バケット内。メイン PDF（{userId}/{testId}.pdf）と同じく先頭が uploaded_by の2階層に揃える
 *（3階層だと Storage / RLS まわりで失敗する環境があるため）。
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
