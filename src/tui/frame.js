// Samples log, status, chrome, and animation onto one paint per 90ms frame.
// input() paints immediately and leaves log and status dirtiness for the next tick.
export function createFrameClock({ paint, isRunning, motion }) {
  let logDirty = false, statusDirty = false, chromeDirty = false, lastFrame = null, lastSecond = null;

  return {
    mark(reason = 'chrome') {
      if (reason === 'log') logDirty = true;
      else if (reason === 'status') statusDirty = true;
      else chromeDirty = true;
    },
    input() {
      paint('input');
      chromeDirty = false;
    },
    tick(now) {
      const running = isRunning();
      const frame = Math.floor(now / 90);
      const second = Math.floor(now / 1000);
      const spinnerDue = running && motion() && frame !== lastFrame;
      const timerDue = running && second !== lastSecond;
      if (!logDirty && !statusDirty && !chromeDirty && !spinnerDue && !timerDue) return false;
      paint('frame');
      logDirty = statusDirty = chromeDirty = false;
      lastFrame = frame;
      lastSecond = second;
      return true;
    },
  };
}
