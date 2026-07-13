import { TICKS_PER_SECOND } from "../types";

export function secondsToTicks(seconds: number): number {
  return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

export function frameDurationTicks(fpsNum: number, fpsDen = 1): number {
  return Math.round((TICKS_PER_SECOND * fpsDen) / fpsNum);
}

export function snapTickToFrame(tick: number, fpsNum: number, fpsDen = 1): number {
  const frame = frameDurationTicks(fpsNum, fpsDen);
  return Math.max(0, Math.round(tick / frame) * frame);
}

export function formatTimecode(tick: number, fpsNum = 30, fpsDen = 1): string {
  const seconds = Math.max(0, ticksToSeconds(tick));
  const displayFps = Math.round(fpsNum / fpsDen);
  const totalFrames = Math.floor(seconds * displayFps + 1e-7);
  const frames = totalFrames % displayFps;
  const totalSeconds = Math.floor(totalFrames / displayFps);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, mins, secs, frames].map((value) => value.toString().padStart(2, "0")).join(":");
}

export function parseTimestamp(value: string): number {
  const parts = value.trim().split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return secondsToTicks(seconds);
}
