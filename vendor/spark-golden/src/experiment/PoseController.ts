import * as THREE from "three";

export interface PoseEvent {
  pose_id: string;
  timestamp_ms: number;
  position: [number, number, number];
  rotation?: [number, number, number, number];
  yaw?: number;
  pitch?: number;
  roll?: number;
}

export interface PoseScript {
  scenario_id: string;
  client_id: string;
  sample_interval_ms: number;
  poses: PoseEvent[];
}

export class PoseController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly script: PoseScript;
  private startMs = 0;
  private index = 0;
  private done = false;

  constructor(camera: THREE.PerspectiveCamera, script: PoseScript) {
    this.camera = camera;
    this.script = script;
  }

  start(startOffsetMs = 0) {
    this.startMs = performance.now() - startOffsetMs;
    this.index = 0;
    this.done = false;
  }

  isDone() {
    return this.done;
  }

  update() {
    if (this.done || this.script.poses.length === 0) return null;
    const elapsed = performance.now() - this.startMs;
    while (
      this.index < this.script.poses.length - 1 &&
      this.script.poses[this.index + 1].timestamp_ms <= elapsed
    ) {
      this.index += 1;
    }
    const pose = this.script.poses[this.index];
    this.applyPose(pose);
    if (
      this.index >= this.script.poses.length - 1 &&
      elapsed >= this.script.poses[this.script.poses.length - 1].timestamp_ms
    ) {
      this.done = true;
    }
    return pose;
  }

  private applyPose(pose: PoseEvent) {
    this.camera.position.set(
      pose.position[0],
      pose.position[1],
      pose.position[2],
    );
    if (pose.rotation) {
      this.camera.quaternion.set(
        pose.rotation[0],
        pose.rotation[1],
        pose.rotation[2],
        pose.rotation[3],
      );
      return;
    }
    const euler = new THREE.Euler(
      THREE.MathUtils.degToRad(pose.pitch ?? 0),
      THREE.MathUtils.degToRad(pose.yaw ?? 0),
      THREE.MathUtils.degToRad(pose.roll ?? 0),
      "YXZ",
    );
    this.camera.quaternion.setFromEuler(euler);
  }
}
