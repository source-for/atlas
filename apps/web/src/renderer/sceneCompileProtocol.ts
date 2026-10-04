import type { WorkerClocks } from '../performance/sceneWorkerTimings';
import type { ArchitectureNeighborhoodPacket } from '@okie/architecture';
import type { ScanSceneInput, ScanModeOptions } from './scanScene';
import type { AtlasScene } from './types';
import type { NeighborhoodBootstrapResult } from './neighborhoodBootstrap';

export type SceneCompileRequest = {
  diagnostics?: true;
  id: number;
  generation: number;
  graph?: Pick<ScanSceneInput, 'snapshot' | 'view' | 'childCounts' | 'unpublishedChildren'>;
  input: Omit<ScanSceneInput, 'snapshot' | 'view' | 'childCounts' | 'unpublishedChildren'>;
  previousId?: number;
};
export type NeighborhoodInitializeRequest = {
  operation: 'initializeNeighborhood';
  diagnostics?: true;
  id: number;
  generation: number;
  packet: ArchitectureNeighborhoodPacket;
  modeOptions: ScanModeOptions;
};
export type SceneWorkerRequest = SceneCompileRequest | NeighborhoodInitializeRequest;
export type SceneCompileResponse = {
  id: number;
  generation: number;
  ok: boolean;
  scene?: AtlasScene;
  durationMs?: number;
};
export type NeighborhoodInitializeResponse = { operation: 'initializeNeighborhood'; id: number; generation: number }
  & (NeighborhoodBootstrapResult | { status: 'failed' });
export type SceneWorkerProgress = { operation: 'progress'; id: number; generation: number; workerPhaseAt?: number; phase: 'received' | 'compiling' | 'compiled' | 'root-slice' | 'projection' | 'layout' | 'adapter' };
export type SceneWorkerTimingResponse = { operation: 'timing'; id: number; generation: number; clocks: WorkerClocks };
export type SceneWorkerResponse = (SceneCompileResponse | NeighborhoodInitializeResponse | SceneWorkerProgress) & { clocks?: WorkerClocks } | SceneWorkerTimingResponse;
