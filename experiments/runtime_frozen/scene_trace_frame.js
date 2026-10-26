"use strict";

// Coit's authored frame is the trace coordinate system. Other scenes keep
// their own authored cameras. Camera paths are world-space; the viewer applies
// mesh scale to the splat object, not to camera.position. Poland's mesh scale
// is 0.05, and multiplying by 0.05/10 shrinks a 16-unit path to 0.08. Measured
// b90 checkpoints moved 0.077 and t=2 matched t=60. Poland therefore adds the
// Coit world delta directly. Cozy and Hobbiton keep scale/10 so cells already
// measured on that gain stay comparable with later cells of the same scene.
const COIT_CAMERA = [-0.858, 2.203, -1.128];
const COIT_SCALE = 10;
const WORLD_CAMERA_GAIN = { "poland-lod": 1 };

const FRAMES = {
  "coit-40m-sh1-lod": {
    identity: true,
    camera: [-0.858, 2.203, -1.128],
    quaternion: [-0.043, -0.909, -0.097, 0.402],
    scale: 10,
  },
  "cozy-spaceship_2-lod": {
    camera: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: 1,
    worldPosition: [0, -6.5, 0],
  },
  "tijerin_w6_hobbiton-lod": {
    camera: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: 1,
    worldQuaternion: [1, 0, 0, 0],
  },
  "poland-lod": {
    camera: [43.7, -3.5, -1.7],
    quaternion: [-0.23, 0.241, 0.006, 0.943],
    scale: 0.05,
    worldQuaternion: [1, 0, 0, 0],
  },
};

function sourcePosition(frame) {
  if (frame.camera && Number.isFinite(frame.camera.x)) {
    return [frame.camera.x, frame.camera.y, frame.camera.z];
  }
  if (Array.isArray(frame.position) && frame.position.length === 3) return frame.position;
  throw new Error("TRACE_FRAME_POSITION_MISSING");
}

function mapTrace(trace, sceneFile) {
  const scene = FRAMES[sceneFile];
  if (!scene) throw new Error(`SCENE_FRAME_UNKNOWN ${sceneFile}`);
  if (scene.identity) return { trace, gain: 1, identity: true };
  const gain = WORLD_CAMERA_GAIN[sceneFile] ?? scene.scale / COIT_SCALE;
  const list = Array.isArray(trace.frames) ? "frames" : "samples";
  const mapped = trace[list].map((frame) => {
    const src = sourcePosition(frame);
    const position = src.map((value, index) => scene.camera[index] + (value - COIT_CAMERA[index]) * gain);
    if (frame.camera) {
      return { ...frame, camera: { x: position[0], y: position[1], z: position[2] } };
    }
    return { ...frame, position };
  });
  return {
    trace: { ...trace, [list]: mapped },
    gain,
    identity: false,
    camera: scene.camera,
    quaternion: scene.quaternion,
  };
}

module.exports = { FRAMES, COIT_CAMERA, COIT_SCALE, mapTrace };
