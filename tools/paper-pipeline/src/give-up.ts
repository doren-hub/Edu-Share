/** 同じ論文を際限なくやり直さないための上限。超えたらその論文だけあきらめて、ほかを続ける */

/** 「3回失敗 → 少し待って再試行」を何巡まで許すか */
export const MAX_FAIL_ROUNDS = 3;
/** 同じ段階の待ちを、進展なしで許す時間。動画の生成は数十分かかるので長めに取る */
export const MAX_STAGE_WAIT_MS = 3 * 60 * 60 * 1000;
/** ブラウザ切断を続けて許す回数 */
export const MAX_DISCONNECTS = 6;

export type GiveUpTrack = {
  failRounds: number;
  waitStage: string;
  waitSince: number;
  disconnects: number;
};

export function emptyGiveUpTrack(): GiveUpTrack {
  return { failRounds: 0, waitStage: "", waitSince: 0, disconnects: 0 };
}

export function maxStageWaitMs(raw: string | undefined = process.env.PAPER_MAX_STAGE_WAIT_MINUTES): number {
  const minutes = Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : MAX_STAGE_WAIT_MS;
}

/** 待ちを記録する。同じ段階の待ちが上限を超えていたら true（あきらめる） */
export function noteWaiting(track: GiveUpTrack, stage: string, now: number, limitMs = maxStageWaitMs()): boolean {
  if (track.waitStage !== stage || track.waitSince <= 0) {
    track.waitStage = stage;
    track.waitSince = now;
    return false;
  }
  return now - track.waitSince > limitMs;
}

/** 利用量待ちやクールダウンの間は、こちらの都合で止めているだけなので待ち時間に数えない */
export function holdWaiting(track: GiveUpTrack, now: number): void {
  if (track.waitSince > 0) track.waitSince = now;
}

/** 3回失敗の1巡を記録する。上限に達したら true（あきらめる） */
export function noteFailRound(track: GiveUpTrack): boolean {
  track.failRounds += 1;
  return track.failRounds >= MAX_FAIL_ROUNDS;
}

/** ブラウザ切断を記録する。上限に達したら true（あきらめる） */
export function noteDisconnect(track: GiveUpTrack): boolean {
  track.disconnects += 1;
  return track.disconnects >= MAX_DISCONNECTS;
}
