/**
 * Avatar and frustum overlay renderer.
 * Draws peer avatars as colored dots + frustum cones using 2D canvas overlay.
 * Runs entirely in the browser, no Spark modification required.
 */
(function () {
  "use strict";

  const colors = ["#f55", "#5af", "#5f5", "#fa0"];

  // Create 2D overlay canvas
  const overlay = document.createElement("canvas");
  overlay.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:9997;";
  overlay.width = window.innerWidth;
  overlay.height = window.innerHeight;
  document.body.appendChild(overlay);
  const ctx = overlay.getContext("2d");

  window.addEventListener("resize", () => {
    overlay.width = window.innerWidth;
    overlay.height = window.innerHeight;
  });

  // World-to-screen projection
  function worldToScreen(pos3, camera, w, h) {
    if (!camera || !pos3) return null;
    try {
      const v = new (window.THREE?.Vector3 ?? class {
        constructor(x,y,z){this.x=x;this.y=y;this.z=z;}
        project(cam) {
          // minimal projection without THREE
          return this;
        }
      })(pos3[0], pos3[1], pos3[2]);
      if (window.THREE) {
        const THREE = window.THREE;
        const vec = new THREE.Vector3(...pos3);
        vec.project(camera);
        return {
          x: (vec.x + 1) / 2 * w,
          y: (-vec.y + 1) / 2 * h,
          behind: vec.z > 1,
        };
      }
    } catch {}
    return null;
  }

  function drawFrame() {
    const w = overlay.width;
    const h = overlay.height;
    ctx.clearRect(0, 0, w, h);

    const camera = window.__slDiagCam;
    const peers = window.__vrcPeers ?? [];
    const decision = window.__vrcDecision;

    // Draw shared demand region label
    if (decision && decision.shared_chunks?.length > 0) {
      ctx.fillStyle = "rgba(255,200,0,0.18)";
      ctx.fillRect(0, 0, w, 20);
      ctx.fillStyle = "#fa0";
      ctx.font = "11px monospace";
      ctx.fillText(`Shared demand: ${decision.shared_chunks.length} chunks  Personalized: ${
        Object.values(decision.personalized_chunks ?? {}).flat().length} chunks`, 8, 14);
    }

    // Draw peer avatars
    peers.forEach((peer, i) => {
      if (!peer?.position) return;
      const color = colors[(i + 1) % colors.length];
      const screen = worldToScreen(peer.position, camera, w, h);
      if (!screen || screen.behind) return;

      // Avatar circle
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = color + "88";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      ctx.fillStyle = color;
      ctx.font = "10px monospace";
      ctx.fillText(peer.user_id ?? `u${i}`, screen.x + 12, screen.y + 4);
    });

    // Local user indicator (top-left corner)
    const uid = window.__vrcUserId ?? "u0";
    const myColor = colors[Number(uid.replace(/\D/g, "")) % colors.length];
    ctx.fillStyle = myColor;
    ctx.font = "bold 11px monospace";
    ctx.fillText(`You: ${uid}`, 8, h - 8);

    window.requestAnimationFrame(drawFrame);
  }

  window.requestAnimationFrame(drawFrame);
})();
