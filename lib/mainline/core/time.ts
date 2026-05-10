/** 新主线沿用 epoch seconds，因为旧仓储层已经采用这个时间形态。 */
export function epochSecondsNow(): number {
  return Math.floor(Date.now() / 1000);
}
