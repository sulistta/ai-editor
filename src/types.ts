export const TICKS_PER_SECOND = 240_000;

export type TrackKind = "video" | "audio" | "caption";
export type JobState = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ProjectSettings {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  sampleRate: number;
  timebase: typeof TICKS_PER_SECOND;
}

export interface MediaAsset {
  id: string;
  name: string;
  path?: string;
  objectUrl?: string;
  durationTicks: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  hasAudio: boolean;
  fingerprint?: string;
  proxyPath?: string;
  waveform?: number[];
  offline: boolean;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  cropTop: number;
  cropRight: number;
  cropBottom: number;
  cropLeft: number;
}

export interface EffectInstance {
  id: string;
  kind: "exposure" | "contrast" | "saturation" | "temperature" | "chromaKey" | "blur";
  enabled: boolean;
  value: number;
}

export type TransitionKind = "crossDissolve" | "dipToBlack" | "wipe" | "slide" | "audioCrossfade";

export interface ClipTransition {
  kind: TransitionKind;
  durationTicks: number;
}

export interface TimelineClip {
  id: string;
  assetId: string;
  name: string;
  startTick: number;
  sourceInTick: number;
  durationTicks: number;
  speed: number;
  volume: number;
  transform: Transform;
  effects: EffectInstance[];
  transitionIn?: ClipTransition;
  transitionOut?: ClipTransition;
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: TrackKind;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  clips: TimelineClip[];
}

export interface Marker {
  id: string;
  tick: number;
  label: string;
}

export interface CaptionCue {
  id: string;
  startTick: number;
  endTick: number;
  text: string;
}

export interface Sequence {
  id: string;
  name: string;
  tracks: TimelineTrack[];
  markers: Marker[];
  captions: CaptionCue[];
}

export interface TranscriptWord {
  text: string;
  startTick: number;
  endTick: number;
  confidence?: number;
}

export interface TranscriptSegment {
  id: string;
  startTick: number;
  endTick: number;
  text: string;
  language?: string;
  speaker?: string;
  words?: TranscriptWord[];
  confidence?: number;
}

export interface Transcript {
  assetId: string;
  engine: "whisper.cpp";
  model: string;
  sourceFingerprint?: string;
  language?: string;
  segments: TranscriptSegment[];
}

export interface EditorProject {
  schemaVersion: 1;
  projectId: string;
  name: string;
  revision: number;
  settings: ProjectSettings;
  assets: MediaAsset[];
  sequences: Sequence[];
  activeSequenceId: string;
  transcripts: Transcript[];
}

export interface Selection {
  clipIds: string[];
  assetId?: string;
  trackId?: string;
}

export interface AgentStep {
  id: string;
  label: string;
  detail?: string;
  state: JobState;
  range?: { startTick: number; endTick: number };
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: number;
}

export interface EditorJob {
  id: string;
  kind: "proxy" | "download" | "transcription" | "render" | "agent";
  label: string;
  state: JobState;
  progress: number;
  detail?: string;
}

export type EditCommand =
  | { type: "setProjectSettings"; settings: ProjectSettings }
  | { type: "addAsset"; asset: MediaAsset }
  | { type: "updateAsset"; asset: MediaAsset }
  | { type: "insertClip"; trackId: string; clip: TimelineClip }
  | { type: "moveClip"; trackId: string; clipId: string; startTick: number }
  | { type: "trimClip"; trackId: string; clipId: string; sourceInTick: number; durationTicks: number }
  | { type: "splitClip"; trackId: string; clipId: string; atTick: number; rightClipId: string }
  | { type: "deleteClip"; trackId: string; clipId: string; ripple: boolean }
  | { type: "updateClip"; trackId: string; clipId: string; patch: Partial<TimelineClip> }
  | { type: "setTranscript"; transcript: Transcript }
  | { type: "setCaptions"; sequenceId: string; captions: CaptionCue[] }
  | { type: "addTrack"; sequenceId: string; track: TimelineTrack }
  | { type: "updateTrack"; sequenceId: string; trackId: string; patch: Partial<Pick<TimelineTrack, "name" | "locked" | "muted" | "hidden">> };

export interface EditTransaction {
  id: string;
  baseRevision: number;
  source: "manual" | "agent";
  label: string;
  commands: EditCommand[];
}

export interface AppError {
  code: string;
  message: string;
  details?: unknown;
  retryable: boolean;
}

export interface MediaProbe {
  durationTicks: number;
  width?: number;
  height?: number;
  fps?: number;
  codec?: string;
  hasAudio: boolean;
  fingerprint?: string;
}

export interface TranscriptionRequest {
  assetId: string;
  mediaPath: string;
  modelPath?: string;
  language?: string;
}

export interface GeminiPlan {
  message: string;
  operations: EditCommand[];
}

export interface DependencyStatus {
  available: boolean;
  detail: string;
}

export interface RuntimeStatus {
  ffmpeg: DependencyStatus;
  ffprobe: DependencyStatus;
  whisper: DependencyStatus;
  model: DependencyStatus;
  youtube: DependencyStatus;
}
