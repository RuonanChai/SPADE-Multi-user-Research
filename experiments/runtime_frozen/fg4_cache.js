"use strict";

const { Fg1 } = require("./fg1_cache");

const BANDS = [
  [4500, 5500],
  [9500, 10500],
];

class Fg4 extends Fg1 {
  lagOk(firstTs, time) {
    const lag = time - firstTs;
    return BANDS.some((band) => lag >= band[0] && lag <= band[1]);
  }

  takeOldest(queue, map, reason, now) {
    const victim = super.takeOldest(queue, map, reason, now);
    if (!victim) return null;
    if (victim.reason === "FG1_COLD_OLDEST") victim.reason = "FG4_COLD_OLDEST";
    if (victim.reason === "FG1_MAIN_OLDEST") victim.reason = "FG4_MAIN_OLDEST";
    return victim;
  }
}

module.exports = { Fg4, BANDS };
