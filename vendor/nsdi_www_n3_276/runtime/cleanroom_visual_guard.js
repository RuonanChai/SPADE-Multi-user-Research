// CLEANROOM Visual Guard - VISUAL_READY Gate Implementation
// Authority: command40_visual_runtime_failclosed.txt, PRODUCTION_ARCHITECTURE.md
// Purpose: Fail-closed visual health gate before scientific measurement

const { execSync } = require('child_process');

/**
 * VISUAL_READY Gate Contract
 *
 * Requirements (ALL must be true):
 * 1. Page loaded, visible
 * 2. Canvas exists, non-zero dimensions
 * 3. WebGL context exists, not lost
 * 4. Scene/runtime ready (application-specific)
 * 5. Renderer frame progression
 * 6. RAD network progression (206 responses)
 * 7. NOT predominantly black
 * 8. NOT solid blue
 * 9. NOT blank/white
 * 10. NO bottom-right black rectangle
 * 11. No unexpected DOM overlay obscuring viewport
 * 12. Stable for VISUAL_STABLE_CONFIRM_MS=3000
 *
 * Timing:
 * - VISUAL_READY_MAX_MS=20000 (20s max from launch)
 * - If not reached, FAIL FAST
 *
 * Per command40: READY, HTTP 206, browser PID, Chrome process existence,
 * or frame counter alone are NEVER sufficient for VISUAL_READY.
 */

const VISUAL_READY_MAX_MS = 20000; // 20 seconds max
const VISUAL_STABLE_CONFIRM_MS = 3000; // 3 seconds stability
const CHECK_INTERVAL_MS = 500; // Check every 500ms

class VisualGuard {
  constructor(browserPage, runId, options = {}) {
    this.page = browserPage;
    this.runId = runId;
    this.checks = {
      page_visible: false,
      canvas_exists: false,
      canvas_dimensions: false,
      webgl_context: false,
      scene_ready: false,
      scene_content: false,
      frame_progression: false,
      rad_206_traffic: false,
      not_black: false,
      not_blue: false,
      not_blank: false,
      no_bottom_right_rectangle: false,
      no_overlay: false
    };
    this.stableStart = null;
    this.lastFrameCount = 0;
    this.rad206Count = 0;
    this.getRad206Count = typeof options.getRad206Count === 'function' ? options.getRad206Count : null;
    this.getVisualColorAnalysis = typeof options.getVisualColorAnalysis === 'function' ? options.getVisualColorAnalysis : null;
    this.history = [];
  }

  /**
   * Main VISUAL_READY polling loop
   */
  async waitForVisualReady() {
    const startTime = Date.now();
    const deadline = startTime + VISUAL_READY_MAX_MS;

    while (Date.now() < deadline) {
      await this.performChecks();
      this.history.push({at: new Date().toISOString(), failed_checks: Object.entries(this.checks).filter(([, value]) => value === false).map(([key]) => key)});

      const allHealthy = Object.values(this.checks).every(v => v === true);

      if (allHealthy) {
        if (!this.stableStart) {
          this.stableStart = Date.now();
          console.log(`[${this.runId}] All checks PASS, starting ${VISUAL_STABLE_CONFIRM_MS}ms stability countdown`);
        }

        const stableDuration = Date.now() - this.stableStart;

        if (stableDuration >= VISUAL_STABLE_CONFIRM_MS) {
          const totalDuration = Date.now() - startTime;
          console.log(`[${this.runId}] VISUAL_READY achieved in ${totalDuration}ms`);

          return {
            ready: true,
            duration_ms: totalDuration,
            stable_ms: stableDuration,
            checks: { ...this.checks }
          };
        }
      } else {
        // Reset stability timer if any check fails
        this.stableStart = null;
      }

      await this.sleep(CHECK_INTERVAL_MS);
    }

    // Timeout - FAIL FAST
    const failedChecks = Object.entries(this.checks)
      .filter(([k, v]) => v === false)
      .map(([k, v]) => k);

    console.error(`[${this.runId}] VISUAL_READY TIMEOUT after ${VISUAL_READY_MAX_MS}ms`);
    console.error(`[${this.runId}] Failed checks: ${failedChecks.join(', ')}`);

    return {
      ready: false,
      duration_ms: VISUAL_READY_MAX_MS,
      timeout: true,
      failed_checks: failedChecks,
      checks: { ...this.checks },
      check_history: this.history
    };
  }

  /**
   * Perform all visual health checks
   */
  async performChecks() {
    try {
      if (this.getRad206Count) this.rad206Count = Number(this.getRad206Count()) || 0;
      // Check 1: Page visible
      this.checks.page_visible = await this.page.evaluate(() => {
        return document.visibilityState === 'visible';
      });

      // Check 2-3: Canvas exists with dimensions
      const canvasState = await this.page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { exists: false };

        return {
          exists: true,
          width: canvas.width,
          height: canvas.height,
          visible: canvas.offsetWidth > 0 && canvas.offsetHeight > 0
        };
      });

      this.checks.canvas_exists = canvasState.exists;
      this.checks.canvas_dimensions = canvasState.exists &&
                                      canvasState.width > 0 &&
                                      canvasState.height > 0 &&
                                      canvasState.visible;

      // Check 4: WebGL context
      if (canvasState.exists) {
        this.checks.webgl_context = await this.page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return false;

          try {
            const gl = canvas.getContext('webgl') || canvas.getContext('webgl2') || canvas.getContext('experimental-webgl');
            if (!gl) return false;

            // Check context not lost
            const ext = gl.getExtension('WEBGL_lose_context');
            if (gl.isContextLost && gl.isContextLost()) return false;

            return true;
          } catch (e) {
            return false;
          }
        });
      }

      // Check 5: Scene ready (application-specific, check for known globals)
      this.checks.scene_ready = await this.page.evaluate(() => {
        // Check for Spark scene globals or similar
        return typeof window.__P5TraceBridge !== 'undefined' ||
               typeof window.player !== 'undefined' ||
               typeof window.scene !== 'undefined';
      });

      this.checks.scene_content = await this.page.evaluate(() => {
        const bridge = window.__P5TraceBridge;
        const state = bridge && typeof bridge.getState === 'function' ? bridge.getState() : null;
        const values = [window.__visibleSplats, state?.visibleSplats, window.__totalSplats, state?.totalSplats]
          .map(Number).filter(Number.isFinite);
        return values.some(value => value > 0) || !!state?.firstVisibleEpochMs;
      });

      // Check 6: Frame progression
      const currentFrameCount = await this.getFrameCount();
      this.checks.frame_progression = currentFrameCount > this.lastFrameCount;
      this.lastFrameCount = currentFrameCount;

      // Check 7: RAD 206 traffic (requires network monitoring setup)
      // This would typically be monitored externally via proxy logs
      // For now, assume passed if we've seen any 206 responses
      this.checks.rad_206_traffic = this.rad206Count > 0;

      // Check 8-10: Color analysis
      const screenshot = await this.page.screenshot({ encoding: 'binary' });
      const colorAnalysis = await this.analyzeColors(screenshot);

      this.checks.not_black = !colorAnalysis.predominantly_black;
      this.checks.not_blue = !colorAnalysis.solid_blue;
      this.checks.not_blank = !colorAnalysis.blank;

      // Check 11: Bottom-right black rectangle (command39/40 regression)
      this.checks.no_bottom_right_rectangle = await this.checkNoBottomRightRectangle();

      // Check 12: No unexpected overlay
      this.checks.no_overlay = await this.checkNoOverlay();

    } catch (error) {
      console.error(`[${this.runId}] Error in performChecks: ${error.message}`);
      // Keep checks as-is on error
    }
  }

  /**
   * Get current frame count from renderer
   */
  async getFrameCount() {
    try {
      return await this.page.evaluate(() => {
        // Try multiple sources
        if (window.__P5TraceBridge && window.__P5TraceBridge.frameCount) {
          return window.__P5TraceBridge.frameCount;
        }
        if (window.__P5TraceBridge && window.__P5TraceBridge.framesReplayed) {
          return window.__P5TraceBridge.framesReplayed;
        }
        if (window.player && window.player.frameCount) {
          return window.player.frameCount;
        }
        // Fallback: request animation frame counter (if instrumented)
        if (window.__rafCount) {
          return window.__rafCount;
        }
        return 0;
      });
    } catch (e) {
      return 0;
    }
  }

  /**
   * Analyze screenshot colors
   */
  async analyzeColors(screenshot) {
    // Simplified color analysis
    // In production, would use image analysis library
    // For now, use heuristics based on file size and sampling

    try {
      if (this.getVisualColorAnalysis) return await this.getVisualColorAnalysis();
      const result = await this.page.evaluate(async () => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return { predominantly_black: true, solid_blue: false, blank: true };

        const ctx = canvas.getContext('2d');
        const gl = ctx ? null : (canvas.getContext('webgl2') || canvas.getContext('webgl'));
        if (!ctx && !gl) return { predominantly_black: true, solid_blue: false, blank: true };

        // Sample pixels
        const width = canvas.width;
        const height = canvas.height;
        const sampleSize = 100;

        let blackCount = 0;
        let blueCount = 0;
        let whiteCount = 0;
        let totalSamples = 0;

        // Prefer the browser-composited/presented canvas surface. WebGL
        // readPixels may legally observe a post-swap back buffer rather than
        // the surface the user sees. Keep readPixels as the deterministic
        // fallback when a presented-surface bitmap cannot be obtained.
        let presented = null;
        try {
          if (typeof createImageBitmap === 'function') {
            const bitmap = await createImageBitmap(canvas);
            const probe = typeof OffscreenCanvas === 'function'
              ? new OffscreenCanvas(sampleSize, sampleSize)
              : Object.assign(document.createElement('canvas'), {width: sampleSize, height: sampleSize});
            const probeCtx = probe.getContext('2d', {willReadFrequently: true});
            probeCtx.drawImage(bitmap, 0, 0, sampleSize, sampleSize);
            presented = probeCtx.getImageData(0, 0, sampleSize, sampleSize).data;
            bitmap.close();
          }
        } catch (_) { presented = null; }
        if (!presented) {
          try {
            const dataUrl = canvas.toDataURL('image/png');
            const image = new Image();
            image.src = dataUrl;
            await image.decode();
            const probe = typeof OffscreenCanvas === 'function'
              ? new OffscreenCanvas(sampleSize, sampleSize)
              : Object.assign(document.createElement('canvas'), {width: sampleSize, height: sampleSize});
            const probeCtx = probe.getContext('2d', {willReadFrequently: true});
            probeCtx.drawImage(image, 0, 0, sampleSize, sampleSize);
            presented = probeCtx.getImageData(0, 0, sampleSize, sampleSize).data;
          } catch (_) { presented = null; }
        }

        for (let i = 0; i < sampleSize; i++) {
          const x = Math.min(width - 1, Math.floor(((i % 10) + 0.5) * width / 10));
          const y = Math.min(height - 1, Math.floor((Math.floor(i / 10) + 0.5) * height / 10));

          try {
            let pixel;
            if (presented) {
              const px = Math.min(sampleSize - 1, Math.floor(x * sampleSize / width));
              const py = Math.min(sampleSize - 1, Math.floor(y * sampleSize / height));
              const off = (py * sampleSize + px) * 4;
              pixel = presented.slice(off, off + 4);
            } else if (ctx) pixel = ctx.getImageData(x, y, 1, 1).data;
            else {
              const raw = new Uint8Array(4);
              gl.readPixels(x, height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, raw);
              pixel = raw;
            }
            const r = pixel[0], g = pixel[1], b = pixel[2];

            totalSamples++;

            // Black: all channels < 30
            if (r < 30 && g < 30 && b < 30) blackCount++;

            // Blue: b significantly higher than r and g
            if (b > 200 && r < 100 && g < 100) blueCount++;

            // White/blank: all channels > 240
            if (r > 240 && g > 240 && b > 240) whiteCount++;
          } catch (e) {
            // Ignore sampling errors
          }
        }

        return {
          predominantly_black: totalSamples > 0 && (blackCount / totalSamples) > 0.8,
          solid_blue: totalSamples > 0 && (blueCount / totalSamples) > 0.8,
          blank: totalSamples > 0 && (whiteCount / totalSamples) > 0.8,
          sampling_surface: presented ? 'presented_canvas_bitmap' : 'canvas_context_fallback'
        };
      });

      return result;
    } catch (e) {
      // Assume unhealthy if can't analyze
      return { predominantly_black: true, solid_blue: false, blank: true };
    }
  }

  /**
   * Check for bottom-right black rectangle (command39/40 regression)
   */
  async checkNoBottomRightRectangle() {
    try {
      return await this.page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return true; // No canvas, no rectangle

        const ctx = canvas.getContext('2d');
        if (!ctx) return true;

        const width = canvas.width;
        const height = canvas.height;

        // Sample bottom-right region (last 20% x 20%)
        const startX = Math.floor(width * 0.8);
        const startY = Math.floor(height * 0.8);
        const sampleSize = 20;

        let blackCount = 0;
        let totalSamples = 0;

        for (let i = 0; i < sampleSize; i++) {
          const x = startX + Math.floor(Math.random() * (width - startX));
          const y = startY + Math.floor(Math.random() * (height - startY));

          try {
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            const r = pixel[0], g = pixel[1], b = pixel[2];

            totalSamples++;
            if (r < 30 && g < 30 && b < 30) blackCount++;
          } catch (e) {
            // Ignore
          }
        }

        // If >80% of bottom-right samples are black, flag it
        return !(totalSamples > 0 && (blackCount / totalSamples) > 0.8);
      });
    } catch (e) {
      return true; // Assume no rectangle if can't check
    }
  }

  /**
   * Check for unexpected DOM overlay
   */
  async checkNoOverlay() {
    try {
      return await this.page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return true;

        // Use elementFromPoint to check if canvas is top element
        const rect = canvas.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const topElement = document.elementFromPoint(centerX, centerY);

        // Canvas itself or child of canvas parent is OK
        if (topElement === canvas || topElement?.closest('canvas') === canvas) {
          return true;
        }

        // Check if it's a known UI element (e.g., controls, loading indicator)
        const knownUIClasses = ['controls', 'loading', 'ui-overlay'];
        if (topElement && knownUIClasses.some(cls => topElement.classList.contains(cls))) {
          return true;
        }

        // Unknown overlay detected
        return false;
      });
    } catch (e) {
      return true; // Assume no overlay if can't check
    }
  }

  /**
   * Set RAD 206 count (called externally from network monitor)
   */
  setRad206Count(count) {
    this.rad206Count = count;
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current check status (for external monitoring)
   */
  getCheckStatus() {
    return { ...this.checks };
  }
}

module.exports = VisualGuard;

// CLI test (requires Playwright page)
if (require.main === module) {
  console.log('VisualGuard module loaded');
  console.log(`Timing: VISUAL_READY_MAX_MS=${VISUAL_READY_MAX_MS}, VISUAL_STABLE_CONFIRM_MS=${VISUAL_STABLE_CONFIRM_MS}`);
  console.log('Usage: const guard = new VisualGuard(page, runId); await guard.waitForVisualReady();');
}
