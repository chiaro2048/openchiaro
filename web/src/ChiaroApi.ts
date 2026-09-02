import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { createContext, useContext } from "react";

export type SceneData = ExcalidrawInitialDataState & {
  elements: readonly ExcalidrawElement[];
  files?: BinaryFiles;
};

export type SceneSnapshot = { scene: SceneData; version: number };

export type AgentTermSummary = {
  instanceId: string;
  agent: string;
  label: string;
  ordinal: number;
  alive: boolean;
  resumable: boolean;
  startedAt: number;
};

export type AgentTermCatalog = {
  agents: { agent: string; label: string }[];
  instances: AgentTermSummary[];
};

export type AgentTermSession = {
  instanceId: string;
  capability: string;
  resumed: boolean;
  freshStart?: boolean;
};

export type AgentState = "away" | "listening" | "working";

export type HubHealth = {
  defaultShell: string;
  pid: number;
  platform: string;
  port: number;
  project: string;
  topic: string;
  topicDir: string;
  version: string;
};

export type TopicCatalog = { topic: string; topics: string[] };

export type GestureOperation = {
  type: "moved" | "added" | "deleted";
  id: string;
  label: string;
};

export type AgentStateEvent = {
  type: "agent-state";
  instanceId: string;
  agent: string;
  state: AgentState;
};

export type FocusInjectionEvent = {
  type: "focus-injection";
  agent: string;
  status: "ok" | "none" | "failed";
  reason: string;
};

export class SceneConflictError extends Error {
  readonly latestVersion: number;

  constructor(latestVersion: number) {
    super("画布已被他人修改");
    this.latestVersion = latestVersion;
  }
}

export type ChiaroApi = {
  loadScene: (topic: string) => Promise<SceneSnapshot>;
  postScene: (topic: string, rawScene: string, baseVersion: number) => Promise<number>;
  postFocus: (topic: string, ids: string[], labels: string[]) => Promise<void>;
  loadAgentTerms: (topic: string, signal?: AbortSignal) => Promise<AgentTermCatalog>;
  postAgentTerm: (topic: string, agent: string) => Promise<AgentTermSession>;
  resumeAgentTerm: (topic: string, instanceId: string) => Promise<AgentTermSession>;
  deleteAgentTerm: (topic: string, instanceId: string) => Promise<void>;
  uploadAgentAttachment: (
    topic: string,
    instanceId: string,
    capability: string,
    image: Blob,
  ) => Promise<string>;
  loadHealth: () => Promise<HubHealth>;
  loadTopics: () => Promise<TopicCatalog>;
  createTopic: (topic: string) => Promise<TopicCatalog>;
  postGesture: (
    topic: string,
    operations: GestureOperation[],
    summary: string,
  ) => Promise<void>;
  connectAgentStateEvents: (
    topic: string,
    onEvent: (event: AgentStateEvent) => void,
    onInjection?: (event: FocusInjectionEvent) => void,
  ) => () => void;
  connectCanvasUpdates: (
    topic: string,
    onUpdate: () => void,
    onError: (message: string) => void,
  ) => () => void;
  terminalSocketUrl: (session: AgentTermSession, topic: string) => string;
};

export const ChiaroApiContext = createContext<ChiaroApi | null>(null);

export function useChiaroApi(): ChiaroApi {
  const api = useContext(ChiaroApiContext);
  if (!api) throw new Error("页面缺少 Chiaro API client");
  return api;
}
