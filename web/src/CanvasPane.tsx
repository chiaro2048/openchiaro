import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  connectCanvasUpdates,
  loadScene,
  postFocus,
  postGesture,
  postScene,
  SceneConflictError,
  type SceneData,
} from "./bridge";
import {
  diffChangedElements,
  diffGestureOperations,
  summarizeGestureOperations,
} from "./sceneDiff";

type CanvasPaneProps = {
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
  onFocusChange: (labels: string[]) => void;
  topic: string;
};

type PendingFocus = { ids: string[]; labels: string[] };

const sceneSignature = (elements: readonly ExcalidrawElement[]) =>
  elements.map(({ id, version }) => `${id}:${version}`).join("|");

function validateEmbeddable(link: string) {
  if (!link.startsWith("/")) return undefined;
  try {
    const url = new URL(link, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

const renderTerminalEmbed: NonNullable<ExcalidrawProps["renderEmbeddable"]> = (element) => {
  const link = element.link;
  if (!link || validateEmbeddable(link) !== true) return null;
  return <iframe src={link} title="嵌入页面" style={{ width: "100%", height: "100%", border: 0 }} />;
};

type OutlineItem = { id: string; text: string; y: number };

// 大纲条目 = 20px 及以上的顶层文本元素（见 SKILL.md 的分区标题规则）
function extractOutline(elements: readonly ExcalidrawElement[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const element of elements) {
    if (element.isDeleted || element.type !== "text") continue;
    if (element.containerId || element.fontSize < 20) continue;
    const text = element.text.split("\n")[0].trim();
    if (text) items.push({ id: element.id, text, y: element.y });
  }
  return items.sort((a, b) => a.y - b.y);
}

function labelsForSelection(elements: readonly ExcalidrawElement[], ids: string[]) {
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  const labels: string[] = [];
  for (const id of ids) {
    const element = elementsById.get(id);
    if (!element) continue;
    if ("text" in element && typeof element.text === "string") labels.push(element.text);
    for (const bound of element.boundElements || []) {
      if (bound.type !== "text") continue;
      const textElement = elementsById.get(bound.id);
      if (textElement && "text" in textElement && typeof textElement.text === "string") {
        labels.push(textElement.text);
      }
    }
  }
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
}

export function CanvasPane({ onApiReady, onFocusChange, topic }: CanvasPaneProps) {
  const [scene, setScene] = useState<SceneData | null>(null);
  const [error, setError] = useState("");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const elementsRef = useRef<readonly ExcalidrawElement[]>([]);
  const gestureBaselineRef = useRef<readonly ExcalidrawElement[]>([]);
  const gestureLatestRef = useRef<readonly ExcalidrawElement[]>([]);
  const sceneVersionRef = useRef(0);
  const sceneSignatureRef = useRef("");
  const selectionSignatureRef = useRef("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const focusTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const pendingFocusRef = useRef<PendingFocus>();
  const lastFocusSentAtRef = useRef(0);
  const lastOwnSaveAtRef = useRef(0);
  const initialFocusDoneRef = useRef(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activeOutlineId, setActiveOutlineId] = useState("");
  const outlineSignatureRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    loadScene(topic)
      .then(({ scene: loaded, version }) => {
        if (cancelled) return;
        elementsRef.current = loaded.elements;
        gestureBaselineRef.current = loaded.elements;
        gestureLatestRef.current = loaded.elements;
        sceneVersionRef.current = version;
        sceneSignatureRef.current = sceneSignature(loaded.elements);
        setOutline(extractOutline(loaded.elements));
        setScene(loaded);
      })
      .catch((cause) => !cancelled && setError(`画布加载失败：${cause.message}`));
    return () => {
      cancelled = true;
    };
  }, [topic]);

  const reloadFromDisk = useCallback(async (force = false) => {
    if (!force && Date.now() - lastOwnSaveAtRef.current < 800) {
      lastOwnSaveAtRef.current = 0;
      return;
    }
    const { scene: next, version } = await loadScene(topic);
    const changed = diffChangedElements(elementsRef.current, next.elements);
    elementsRef.current = next.elements;
    gestureBaselineRef.current = next.elements;
    gestureLatestRef.current = next.elements;
    sceneVersionRef.current = version;
    sceneSignatureRef.current = sceneSignature(next.elements);
    const api = apiRef.current;
    if (!api) return;
    api.updateScene({ elements: next.elements });
    if (next.files) api.addFiles(Object.values(next.files));
    if (changed.length) {
      requestAnimationFrame(() => api.scrollToContent(changed, { animate: true }));
    }
    setError("");
  }, [topic]);

  useEffect(() => {
    if (!scene) return;
    return connectCanvasUpdates(
      topic,
      () => reloadFromDisk().catch((cause) => setError(`画布刷新失败：${cause.message}`)),
      setError,
    );
  }, [reloadFromDisk, scene, topic]);

  useEffect(
    () => () => {
      clearTimeout(saveTimerRef.current);
      clearTimeout(gestureTimerRef.current);
      clearTimeout(focusTimerRef.current);
    },
    [],
  );

  const sendPendingFocus = () => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = undefined;
    lastFocusSentAtRef.current = Date.now();
    postFocus(topic, pending.ids, pending.labels).catch((cause) =>
      setError(`Focus 写入失败：${cause.message}`),
    );
  };

  const onChange: NonNullable<ExcalidrawProps["onChange"]> = (elements, appState, files) => {
    const api = apiRef.current;
    if (!initialFocusDoneRef.current && api) {
      initialFocusDoneRef.current = true;
      const latest = elements
        .filter((element) => !element.isDeleted && Number.isFinite(element.updated))
        .sort((a, b) => a.updated - b.updated)
        .at(-1);
      if (latest) {
        requestAnimationFrame(() => api.scrollToContent(latest, { animate: true }));
      }
    }
    elementsRef.current = elements;
    gestureLatestRef.current = elements;
    const nextSceneSignature = sceneSignature(elements);
    if (nextSceneSignature !== sceneSignatureRef.current) {
      sceneSignatureRef.current = nextSceneSignature;
      const items = extractOutline(elements);
      const outlineSignature = items.map((item) => `${item.id}:${item.text}:${item.y}`).join("|");
      if (outlineSignature !== outlineSignatureRef.current) {
        outlineSignatureRef.current = outlineSignature;
        setOutline(items);
      }
      clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = setTimeout(() => {
        const next = gestureLatestRef.current;
        const operations = diffGestureOperations(gestureBaselineRef.current, next);
        gestureBaselineRef.current = next;
        if (!operations.length) return;
        postGesture(topic, operations, summarizeGestureOperations(operations)).catch((cause) =>
          setError(`手势记录失败：${cause.message}`),
        );
      }, 500);
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        postScene(
          topic,
          serializeAsJSON(elements, appState, files, "local"),
          sceneVersionRef.current,
        ).then((version) => {
          sceneVersionRef.current = version;
          lastOwnSaveAtRef.current = Date.now();
          setError("");
        }).catch((cause) => {
          if (cause instanceof SceneConflictError) {
            void reloadFromDisk(true)
              .then(() => setError("画布已被他人修改"))
              .catch((reloadCause) => setError(`画布冲突后重载失败：${reloadCause.message}`));
            return;
          }
          setError(`画布保存失败：${cause.message}`);
        });
      }, 800);
    }

    // 视口中心落在哪个分区（该标题 y 至下一标题 y 之间）→ 大纲条高亮
    if (appState.height && appState.zoom?.value) {
      const centerY = appState.height / 2 / appState.zoom.value - appState.scrollY;
      let active = "";
      for (const item of outline) {
        if (item.y <= centerY) active = item.id;
        else break;
      }
      if (active !== activeOutlineId) setActiveOutlineId(active);
    }

    const ids = Object.keys(appState.selectedElementIds).filter(
      (id) => appState.selectedElementIds[id],
    );
    const nextSelectionSignature = ids.sort().join("|");
    if (nextSelectionSignature === selectionSignatureRef.current) return;
    selectionSignatureRef.current = nextSelectionSignature;
    const labels = labelsForSelection(elements, ids);
    onFocusChange(labels);
    pendingFocusRef.current = { ids, labels };

    const remaining = 300 - (Date.now() - lastFocusSentAtRef.current);
    if (remaining <= 0) sendPendingFocus();
    else if (!focusTimerRef.current) {
      focusTimerRef.current = setTimeout(() => {
        focusTimerRef.current = undefined;
        sendPendingFocus();
      }, remaining);
    }
  };

  const railRef = useRef<HTMLElement | null>(null);
  // Dock 式波浪 + 区域命中：鼠标在整条 rail 上滑动即可——最近的刻度成为波峰
  // （放大 + 浮出标题），点击 rail 任意位置触发波峰条目，无需精准点中小刻度。
  // 直接操作 style/类名，避免高频 re-render。
  const nearestTick = (clientY: number) => {
    const rail = railRef.current;
    if (!rail) return null;
    let nearest: HTMLButtonElement | null = null;
    let nearestDistance = Infinity;
    for (const tick of rail.querySelectorAll<HTMLButtonElement>(".outline-tick")) {
      const rect = tick.getBoundingClientRect();
      const distance = Math.abs(clientY - (rect.top + rect.height / 2));
      const boost = Math.exp(-((distance / 56) ** 2));
      tick.style.width = `${12 + 26 * boost}px`;
      tick.style.height = `${4 + 3 * boost}px`;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = tick;
      }
    }
    for (const tick of rail.querySelectorAll<HTMLButtonElement>(".outline-tick.peak")) {
      if (tick !== nearest) tick.classList.remove("peak");
    }
    nearest?.classList.add("peak");
    return nearest;
  };
  const handleRailMove = (event: React.MouseEvent) => {
    nearestTick(event.clientY);
  };
  const handleRailLeave = () => {
    const rail = railRef.current;
    if (!rail) return;
    for (const tick of rail.querySelectorAll<HTMLButtonElement>(".outline-tick")) {
      tick.style.width = "";
      tick.style.height = "";
      tick.classList.remove("peak");
    }
  };
  const handleRailClick = (event: React.MouseEvent) => {
    const target = nearestTick(event.clientY);
    const id = target?.dataset.outlineId;
    if (id) jumpToOutline(id);
  };

  const jumpToOutline = (id: string) => {
    const api = apiRef.current;
    const element = elementsRef.current.find((candidate) => candidate.id === id);
    if (!api || !element) return;
    api.scrollToContent(element, { animate: true });
    // 选中标题元素：既是视觉落点，也顺着既有 onChange 链路把 Focus 报给 agent
    api.updateScene({ appState: { selectedElementIds: { [id]: true } } });
  };

  if (error && !scene) return <div className="canvas-fatal">{error}</div>;
  if (!scene) return <div className="canvas-fatal">正在加载画布…</div>;

  return (
    <div className="canvas-pane">
      <Excalidraw
        initialData={scene}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          onApiReady(api);
        }}
        onChange={onChange}
        validateEmbeddable={validateEmbeddable}
        renderEmbeddable={renderTerminalEmbed}
      />
      {outline.length > 0 && (
        <nav
          className="outline-rail"
          aria-label="画布大纲"
          ref={(node) => { railRef.current = node; }}
          onMouseMove={handleRailMove}
          onMouseLeave={handleRailLeave}
          onClick={handleRailClick}
        >
          {outline.map((item) => (
            <button
              key={item.id}
              type="button"
              data-outline-id={item.id}
              className={item.id === activeOutlineId ? "outline-tick active" : "outline-tick"}
            >
              <span className="outline-tip">{item.text}</span>
            </button>
          ))}
        </nav>
      )}
      {scene.elements.length === 0 && <div className="canvas-notice">画布为空，可以直接开始绘制</div>}
      {error && <div className="canvas-error">{error}</div>}
    </div>
  );
}
