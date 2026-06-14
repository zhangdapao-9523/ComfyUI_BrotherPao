import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "BrotherPao_FramesEditor";
const DOM_WIDGET_NAME = "bp_frames_editor";
const DEFAULT_SIZE = [460, 560];
const MIN_EDITOR_HEIGHT = 300;
const instances = new WeakMap();

function markDirty(node) {
    node?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function chainCallback(object, property, callback) {
    if (!object) return;
    const original = object[property];
    object[property] = function () {
        const result = original?.apply(this, arguments);
        callback.apply(this, arguments);
        return result;
    };
}

function imageUrl(imageInfo) {
    if (!imageInfo || !imageInfo.filename) return "";
    const params = new URLSearchParams({
        filename: imageInfo.filename || "",
        type: imageInfo.type || "temp",
        subfolder: imageInfo.subfolder || "",
        rand: String(Math.random()),
    });
    return api.apiURL(`/view?${params.toString()}`);
}

function normalizePreviewFrames(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.images)) return value.images;
    if (Array.isArray(value.preview_images)) return value.preview_images;
    return [];
}

function getPreviewFromOutput(output) {
    const previewPayload = output?.preview?.[0] || output?.ui?.preview?.[0];
    if (previewPayload?.preview_str) {
        try {
            const parsed = typeof previewPayload.preview_str === "string"
                ? JSON.parse(previewPayload.preview_str)
                : previewPayload.preview_str;
            return {
                frames: normalizePreviewFrames(parsed),
                isInit: Boolean(previewPayload.is_init),
            };
        } catch (error) {
            console.error("[FramesEditor] Failed to parse preview payload:", error, previewPayload);
        }
    }

    return {
        frames: normalizePreviewFrames(output?.images || output?.preview_images || output?.ui?.images),
        isInit: true,
    };
}

function locale() {
    try {
        const value = app.ui?.settings?.getSettingValue?.("Comfy.Locale");
        return value && String(value).toLowerCase().startsWith("zh") ? "zh" : "en";
    } catch (_) {
        return navigator.language?.startsWith("zh") ? "zh" : "en";
    }
}

function t(en, zh) {
    return locale() === "zh" ? zh : en;
}

function cloneState(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function makeButton(icon, title, onClick) {
    const button = document.createElement("button");
    button.className = "bp-frame-btn";
    button.type = "button";
    button.title = title;
    button.innerHTML = icon;
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });
    return button;
}

function consumeContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    return false;
}

function readInfo(node) {
    const infoWidget = node.widgets?.find((widget) => widget.name === "info");
    if (!infoWidget?.value) return null;
    try {
        return JSON.parse(infoWidget.value);
    } catch (_) {
        return null;
    }
}

function emptyFrameState() {
    return { positivePoints: [], negativePoints: [], bboxes: [] };
}

function currentFrameState(instance) {
    return {
        positivePoints: cloneState(instance.positivePoints),
        negativePoints: cloneState(instance.negativePoints),
        bboxes: cloneState(instance.bboxes),
    };
}

function hasFrameContent(state) {
    return Boolean(state?.positivePoints?.length || state?.negativePoints?.length || state?.bboxes?.length);
}

function frameKey(frameIndex) {
    return String(Number(frameIndex) || 0);
}

function saveCurrentFrame(instance) {
    const key = frameKey(instance.frameIndex);
    const state = currentFrameState(instance);
    if (hasFrameContent(state)) {
        instance.framesData[key] = state;
    } else {
        delete instance.framesData[key];
    }
}

function loadFrameState(instance, frameIndex) {
    const state = instance.framesData[frameKey(frameIndex)] || emptyFrameState();
    instance.positivePoints = cloneState(state.positivePoints);
    instance.negativePoints = cloneState(state.negativePoints);
    instance.bboxes = cloneState(state.bboxes);
    instance.history = instance.framesHistory[frameKey(frameIndex)] || [];
    instance.historyIndex = instance.framesHistoryIndex[frameKey(frameIndex)] ?? -1;
}

function saveCurrentHistory(instance) {
    const key = frameKey(instance.frameIndex);
    if (instance.history.length) {
        instance.framesHistory[key] = instance.history;
        instance.framesHistoryIndex[key] = instance.historyIndex;
    } else {
        delete instance.framesHistory[key];
        delete instance.framesHistoryIndex[key];
    }
}

function frameToInfo(frameIndex, state) {
    return {
        frame_index: Number(frameIndex),
        positive_coords: cloneState(state.positivePoints || []),
        negative_coords: cloneState(state.negativePoints || []),
        bbox: cloneState(state.bboxes || []),
    };
}

function allFrameInfos(instance) {
    saveCurrentFrame(instance);
    return Object.entries(instance.framesData)
        .map(([index, state]) => frameToInfo(index, state))
        .filter((frame) => frame.positive_coords.length || frame.negative_coords.length || frame.bbox.length)
        .sort((a, b) => a.frame_index - b.frame_index);
}

function infoPayload(instance) {
    return {
        current_frame_index: instance.frameIndex,
        frames: allFrameInfos(instance),
    };
}

function formatInfoText(node) {
    const infoWidget = node.widgets?.find((widget) => widget.name === "info");
    const raw = infoWidget?.value || "";
    if (!raw) return "{\n  \"current_frame_index\": 0,\n  \"frames\": []\n}";
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch (_) {
        return raw;
    }
}

function showInfoOverlay(node, instance) {
    instance.infoText.textContent = formatInfoText(node);
    instance.infoOverlay.hidden = false;
}

function hideInfoOverlay(instance) {
    instance.infoOverlay.hidden = true;
}

function writeInfo(node, instance) {
    const infoWidget = node.widgets?.find((widget) => widget.name === "info");
    if (!infoWidget) return;

    saveCurrentHistory(instance);
    const value = JSON.stringify(infoPayload(instance));

    if (infoWidget.value !== value) {
        infoWidget.value = value;
        if (instance.infoOverlay && !instance.infoOverlay.hidden) {
            instance.infoText.textContent = formatInfoText(node);
        }
        markDirty(node);
    }
}

function loadFrame(node, instance, frameIndex, saveCurrent = true) {
    if (!instance.previewFrames.length) return;
    if (saveCurrent) {
        saveCurrentFrame(instance);
        saveCurrentHistory(instance);
    }
    const safeIndex = Math.max(0, Math.min(frameIndex, instance.previewFrames.length - 1));
    instance.frameIndex = safeIndex;
    loadFrameState(instance, safeIndex);
    instance.slider.value = String(safeIndex);
    instance.frameInfo.textContent = `${safeIndex + 1}/${instance.previewFrames.length}`;
    writeInfo(node, instance);

    const img = new Image();
    img.onload = () => {
        instance.image = img;
        instance.canvas.width = img.width;
        instance.canvas.height = img.height;
        redraw(instance);
        markDirty(node);
    };
    img.onerror = () => {
        instance.image = null;
        redraw(instance, t("Failed to load preview frame", "预览帧加载失败"));
        console.error("[FramesEditor] Failed to load image:", img.src, instance.previewFrames[safeIndex]);
        markDirty(node);
    };
    const url = imageUrl(instance.previewFrames[safeIndex]);
    if (!url) {
        img.onerror();
        return;
    }
    img.src = url;
}

function setMode(instance, mode) {
    instance.mode = mode;
    instance.pointBtn.classList.toggle("active", mode === "point");
    instance.boxBtn.classList.toggle("active", mode === "box");
}

function pushHistory(node, instance) {
    if (instance.historyIndex < instance.history.length - 1) {
        instance.history = instance.history.slice(0, instance.historyIndex + 1);
    }
    instance.history.push({
        positivePoints: cloneState(instance.positivePoints),
        negativePoints: cloneState(instance.negativePoints),
        bboxes: cloneState(instance.bboxes),
    });
    instance.historyIndex += 1;
    saveCurrentFrame(instance);
    saveCurrentHistory(instance);
    updateToolbar(instance);
    writeInfo(node, instance);
}

function restoreState(node, instance, state) {
    instance.positivePoints = cloneState(state.positivePoints || []);
    instance.negativePoints = cloneState(state.negativePoints || []);
    instance.bboxes = cloneState(state.bboxes || []);
    saveCurrentFrame(instance);
    saveCurrentHistory(instance);
    redraw(instance);
    updateToolbar(instance);
    writeInfo(node, instance);
}

function hasAnyFrameContent(instance) {
    saveCurrentFrame(instance);
    return Object.values(instance.framesData).some(hasFrameContent);
}

function updateToolbar(instance) {
    const canUndo = instance.historyIndex >= 0;
    const canRedo = instance.historyIndex < instance.history.length - 1;
    const hasContent = hasAnyFrameContent(instance);
    instance.undoBtn.disabled = !canUndo;
    instance.redoBtn.disabled = !canRedo;
    instance.clearBtn.disabled = !hasContent;
}

function undo(node, instance) {
    if (instance.historyIndex > 0) {
        instance.historyIndex -= 1;
        restoreState(node, instance, instance.history[instance.historyIndex]);
    } else if (instance.historyIndex === 0) {
        instance.historyIndex = -1;
        restoreState(node, instance, {});
    }
}

function redo(node, instance) {
    if (instance.historyIndex >= instance.history.length - 1) return;
    instance.historyIndex += 1;
    restoreState(node, instance, instance.history[instance.historyIndex]);
}

function clearAll(node, instance) {
    if (!hasAnyFrameContent(instance)) return;
    instance.positivePoints = [];
    instance.negativePoints = [];
    instance.bboxes = [];
    instance.framesData = {};
    instance.framesHistory = {};
    instance.framesHistoryIndex = {};
    instance.history = [];
    instance.historyIndex = -1;
    redraw(instance);
    updateToolbar(instance);
    writeInfo(node, instance);
}

function canvasCoords(instance, event) {
    const rect = instance.canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * (instance.canvas.width / rect.width),
        y: (event.clientY - rect.top) * (instance.canvas.height / rect.height),
    };
}

function redraw(instance, statusText = null) {
    const { canvas, ctx, image, positivePoints, negativePoints, bboxes, currentBox } = instance;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (image) {
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#d8d8d8";
        ctx.font = "22px sans-serif";
        ctx.textAlign = "center";
        const lines = statusText ? [statusText] : [
            t("Run the node to load frames", "运行节点后加载帧"),
            t("Left click: positive point", "左键：正向点"),
            t("Right click: negative point", "右键：负向点"),
            t("Box mode: drag to draw box", "框选模式：拖动绘制边界框"),
        ];
        lines.forEach((line, index) => {
            ctx.fillText(line, canvas.width / 2, canvas.height / 2 - 52 + index * 36);
        });
    }

    ctx.lineWidth = 2;
    for (const box of bboxes) {
        ctx.strokeStyle = "#3b82f6";
        ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        ctx.fillRect(box.x, box.y, box.w, box.h);
    }

    if (currentBox) {
        ctx.strokeStyle = "#22d3ee";
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(currentBox.x, currentBox.y, currentBox.w, currentBox.h);
        ctx.setLineDash([]);
    }

    const radius = Math.max(3, Math.min(canvas.width, canvas.height) * 0.008);
    drawPoints(ctx, positivePoints, radius, "#22c55e");
    drawPoints(ctx, negativePoints, radius, "#ef4444");
}

function drawPoints(ctx, points, radius, color) {
    ctx.strokeStyle = "#111";
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    for (const point of points) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }
}

function normalizeStoredBBox(box) {
    if (box && typeof box === "object" && !Array.isArray(box)) {
        return {
            x: Number(box.x) || 0,
            y: Number(box.y) || 0,
            w: Number(box.w) || 0,
            h: Number(box.h) || 0,
        };
    }
    if (Array.isArray(box) && box.length === 4) {
        const x = Number(box[0]) || 0;
        const y = Number(box[1]) || 0;
        return {
            x,
            y,
            w: Math.max(0, (Number(box[2]) || 0) - x),
            h: Math.max(0, (Number(box[3]) || 0) - y),
        };
    }
    return null;
}

function stateFromInfoFrame(frame) {
    const state = {
        positivePoints: Array.isArray(frame?.positive_coords) ? cloneState(frame.positive_coords) : [],
        negativePoints: Array.isArray(frame?.negative_coords) ? cloneState(frame.negative_coords) : [],
        bboxes: [],
    };
    if (Array.isArray(frame?.bbox)) {
        state.bboxes = frame.bbox.map(normalizeStoredBBox).filter(Boolean).filter((box) => box.w > 0 && box.h > 0);
    }
    return state;
}

function applyStoredInfo(node, instance) {
    const info = readInfo(node);
    if (!info) return;

    instance.framesData = {};
    instance.framesHistory = {};
    instance.framesHistoryIndex = {};

    const frames = Array.isArray(info.frames)
        ? info.frames
        : [{
            frame_index: info.frame_index ?? info.current_frame_index ?? 0,
            positive_coords: info.positive_coords,
            negative_coords: info.negative_coords,
            bbox: info.bbox,
        }];

    for (const frame of frames) {
        const index = Number(frame?.frame_index);
        if (!Number.isFinite(index)) continue;
        const state = stateFromInfoFrame(frame);
        if (hasFrameContent(state)) {
            instance.framesData[frameKey(index)] = state;
        }
    }

    const currentIndex = Number(info.current_frame_index ?? info.frame_index ?? 0);
    instance.frameIndex = Number.isFinite(currentIndex) ? Math.max(0, currentIndex) : 0;
    loadFrameState(instance, instance.frameIndex);
    redraw(instance);
    updateToolbar(instance);
}

function buildEditor(node) {
    const container = document.createElement("div");
    container.className = "bp-frame-editor";

    const toolbar = document.createElement("div");
    toolbar.className = "bp-frame-toolbar";
    container.appendChild(toolbar);

    const left = document.createElement("div");
    left.className = "bp-frame-btn-group";
    toolbar.appendChild(left);

    const right = document.createElement("div");
    right.className = "bp-frame-btn-group";
    toolbar.appendChild(right);

    const icons = {
        undo: `<svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>`,
        redo: `<svg viewBox="0 0 24 24"><path d="M18.4 10.6C16.55 9 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z"/></svg>`,
        clear: `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
        info: `<svg viewBox="0 0 24 24"><path d="M11 17h2v-6h-2v6zm0-8h2V7h-2v2zm1-7C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/></svg>`,
        point: `<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`,
        box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="4 4"/></svg>`,
    };

    const stage = document.createElement("div");
    stage.className = "bp-frame-stage";
    container.appendChild(stage);

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    stage.appendChild(canvas);

    const tracker = document.createElement("div");
    tracker.className = "bp-frame-tracker";
    tracker.hidden = true;
    container.appendChild(tracker);

    const frameInfo = document.createElement("div");
    frameInfo.className = "bp-frame-info";
    frameInfo.textContent = "0/0";
    tracker.appendChild(frameInfo);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "0";
    slider.value = "0";
    slider.step = "1";
    tracker.appendChild(slider);

    const infoOverlay = document.createElement("div");
    infoOverlay.className = "bp-frame-info-overlay";
    infoOverlay.hidden = true;
    container.appendChild(infoOverlay);

    const infoPanel = document.createElement("div");
    infoPanel.className = "bp-frame-info-panel";
    infoOverlay.appendChild(infoPanel);

    const infoHeader = document.createElement("div");
    infoHeader.className = "bp-frame-info-header";
    infoPanel.appendChild(infoHeader);

    const infoTitle = document.createElement("div");
    infoTitle.textContent = t("Annotation Info", "标注信息");
    infoHeader.appendChild(infoTitle);

    const infoClose = document.createElement("button");
    infoClose.type = "button";
    infoClose.title = t("Close", "关闭");
    infoClose.textContent = "×";
    infoHeader.appendChild(infoClose);

    const infoText = document.createElement("pre");
    infoText.className = "bp-frame-info-text";
    infoPanel.appendChild(infoText);

    const instance = {
        node,
        container,
        stage,
        canvas,
        ctx: canvas.getContext("2d"),
        tracker,
        frameInfo,
        slider,
        infoOverlay,
        infoText,
        widget: null,
        image: null,
        previewFrames: [],
        frameIndex: 0,
        framesData: {},
        framesHistory: {},
        framesHistoryIndex: {},
        positivePoints: [],
        negativePoints: [],
        bboxes: [],
        history: [],
        historyIndex: -1,
        mode: "point",
        isDrawingBox: false,
        currentBox: null,
    };

    instance.undoBtn = makeButton(icons.undo, t("Undo", "撤销"), () => undo(node, instance));
    instance.redoBtn = makeButton(icons.redo, t("Redo", "重做"), () => redo(node, instance));
    instance.clearBtn = makeButton(icons.clear, t("Clear All", "清空"), () => clearAll(node, instance));
    instance.infoBtn = makeButton(icons.info, t("Show Info", "查看信息"), () => showInfoOverlay(node, instance));
    instance.pointBtn = makeButton(icons.point, t("Point Mode", "点选模式"), () => setMode(instance, "point"));
    instance.boxBtn = makeButton(icons.box, t("Box Mode", "框选模式"), () => setMode(instance, "box"));

    left.append(instance.undoBtn, instance.redoBtn, instance.clearBtn, instance.infoBtn);
    right.append(instance.pointBtn, instance.boxBtn);

    infoClose.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideInfoOverlay(instance);
    });
    infoOverlay.addEventListener("click", (event) => {
        if (event.target === infoOverlay) hideInfoOverlay(instance);
    });
    infoPanel.addEventListener("click", (event) => event.stopPropagation());

    slider.addEventListener("input", () => loadFrame(node, instance, Number(slider.value)));
    for (const element of [container, stage, canvas]) {
        element.addEventListener("contextmenu", consumeContextMenu, { capture: true });
    }
    canvas.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (!instance.image) return;

        const point = canvasCoords(instance, event);
        if (instance.mode === "point") {
            if (event.button === 0) instance.positivePoints.push(point);
            else if (event.button === 2) instance.negativePoints.push(point);
            else return;
            pushHistory(node, instance);
            redraw(instance);
        } else if (instance.mode === "box" && event.button === 0) {
            instance.isDrawingBox = true;
            instance.currentBox = { x: point.x, y: point.y, w: 0, h: 0 };
        }
    });
    canvas.addEventListener("mousemove", (event) => {
        if (!instance.image || !instance.isDrawingBox || !instance.currentBox) return;
        event.preventDefault();
        event.stopPropagation();
        const point = canvasCoords(instance, event);
        instance.currentBox.w = point.x - instance.currentBox.x;
        instance.currentBox.h = point.y - instance.currentBox.y;
        redraw(instance);
    });
    canvas.addEventListener("mouseup", (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        if (!instance.image || !instance.isDrawingBox || !instance.currentBox) return;
        const box = {
            x: Math.min(instance.currentBox.x, instance.currentBox.x + instance.currentBox.w),
            y: Math.min(instance.currentBox.y, instance.currentBox.y + instance.currentBox.h),
            w: Math.abs(instance.currentBox.w),
            h: Math.abs(instance.currentBox.h),
        };
        instance.isDrawingBox = false;
        instance.currentBox = null;
        if (box.w > 5 && box.h > 5) {
            instance.bboxes.push(box);
            pushHistory(node, instance);
        }
        redraw(instance);
    });

    instances.set(node, instance);
    setMode(instance, "point");
    applyStoredInfo(node, instance);
    redraw(instance);
    return instance;
}

function updateHeight(node) {
    const instance = instances.get(node);
    if (!instance?.widget) return;

    let topOffset = 0;
    for (const widget of node.widgets || []) {
        if (widget === instance.widget) {
            topOffset = widget.last_y || 0;
            break;
        }
    }

    const height = Math.max(MIN_EDITOR_HEIGHT, (node.size?.[1] || DEFAULT_SIZE[1]) - topOffset - 24);
    instance.container.style.height = `${height}px`;
}

function createWidget(node) {
    if (typeof node.addDOMWidget !== "function") return null;

    const instance = instances.get(node) || buildEditor(node);
    if (instance.widget && node.widgets?.includes(instance.widget)) return instance.widget;

    const widget = node.addDOMWidget(DOM_WIDGET_NAME, "brotherpao-frames-editor", instance.container, {
        getMinHeight: () => MIN_EDITOR_HEIGHT,
        getHeight: () => instance.container.clientHeight || 400,
        hideOnZoom: false,
        serialize: false,
    });
    widget.computeSize = (width) => [width, 400];
    widget.serialize = false;
    instance.widget = widget;

    if (!node._bpFramesEditorResizePatched) {
        node._bpFramesEditorResizePatched = true;
        chainCallback(node, "onResize", function () {
            requestAnimationFrame(() => updateHeight(this));
        });
        chainCallback(node, "onDrawForeground", function () {
            updateHeight(this);
        });
    }

    requestAnimationFrame(() => requestAnimationFrame(() => {
        updateHeight(node);
        markDirty(node);
    }));
    return widget;
}

function installExecutedHandler(node) {
    if (node._bpFramesEditorExecutedInstalled) return;
    node._bpFramesEditorExecutedInstalled = true;
    const original = node.onExecuted;
    node.onExecuted = function (output) {
        original?.call(this, output);
        const instance = instances.get(this);
        if (!instance) return;

        const { frames, isInit } = getPreviewFromOutput(output);
        if (!frames.length) {
            redraw(instance, t("No preview frames returned", "节点未返回预览帧"));
            console.warn("[FramesEditor] No preview frames in output:", output);
            return;
        }

        instance.previewFrames = frames;

        if (isInit && instance.frameIndex >= instance.previewFrames.length) {
            instance.frameIndex = 0;
            restoreState(this, instance, {});
            instance.history = [];
            instance.historyIndex = -1;
        }

        instance.tracker.hidden = instance.previewFrames.length <= 1;
        instance.slider.max = String(Math.max(0, instance.previewFrames.length - 1));
        if (instance.frameIndex >= instance.previewFrames.length) instance.frameIndex = 0;
        loadFrame(this, instance, instance.frameIndex);
        updateToolbar(instance);
    };
}

function installInfoWidgetPopup(node) {
    if (node._bpFramesEditorInfoPopupInstalled) return;
    node._bpFramesEditorInfoPopupInstalled = true;

    const original = node.onMouseDown;
    node.onMouseDown = function (event, pos) {
        const infoWidget = this.widgets?.find((widget) => widget.name === "info");
        const instance = instances.get(this);
        if (infoWidget && instance && Array.isArray(pos)) {
            const top = infoWidget.last_y ?? -1;
            const height = infoWidget.last_h || infoWidget.height || 28;
            if (top >= 0 && pos[1] >= top && pos[1] <= top + height) {
                showInfoOverlay(this, instance);
                return true;
            }
        }
        return original?.call(this, event, pos);
    };
}

function initializeNode(node) {
    if (node._bpFramesEditorInitialized) return;
    node._bpFramesEditorInitialized = true;

    if (!node.size || node.size[0] < DEFAULT_SIZE[0] || node.size[1] < DEFAULT_SIZE[1]) {
        node.setSize?.([
            Math.max(node.size?.[0] || 0, DEFAULT_SIZE[0]),
            Math.max(node.size?.[1] || 0, DEFAULT_SIZE[1]),
        ]);
    }

    createWidget(node);
    installExecutedHandler(node);
    installInfoWidgetPopup(node);
}

app.registerExtension({
    name: "ComfyUI_BrotherPao.FramesEditor",

    nodeCreated(node) {
        if (node.constructor?.comfyClass !== NODE_CLASS) return;
        initializeNode(node);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            initializeNode(this);
        });
    },
});

(function injectCSS() {
    if (document.getElementById("bp-frames-editor-style")) return;
    const style = document.createElement("style");
    style.id = "bp-frames-editor-style";
    style.textContent = `
.bp-frame-editor {
    width: 100%;
    height: 100%;
    min-height: 300px;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 4px;
    background: #101113;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.bp-frame-toolbar,
.bp-frame-tracker {
    flex: 0 0 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    background: #222326;
    border-bottom: 1px solid #33363b;
    padding: 0 5px;
}
.bp-frame-tracker {
    border-top: 1px solid #33363b;
    border-bottom: 0;
    gap: 8px;
}
.bp-frame-btn-group {
    display: flex;
    gap: 4px;
}
.bp-frame-btn {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #cfd3da;
    cursor: pointer;
    padding: 0;
}
.bp-frame-btn:hover:not(:disabled),
.bp-frame-btn.active {
    background: #3a3d44;
    color: #fff;
}
.bp-frame-btn:disabled {
    color: #5b5f68;
    cursor: default;
}
.bp-frame-btn svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
}
.bp-frame-stage {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #101113;
}
.bp-frame-stage canvas {
    display: block;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: crosshair;
}
.bp-frame-info {
    min-width: 46px;
    color: #cfd3da;
    font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;
    text-align: center;
    user-select: none;
}
.bp-frame-info-overlay {
    position: absolute;
    inset: 32px 8px 40px 8px;
    z-index: 20;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 8px;
    background: rgba(0, 0, 0, 0.35);
}
.bp-frame-info-overlay[hidden] {
    display: none;
}
.bp-frame-info-panel {
    width: min(520px, 96%);
    max-height: 82%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid #4b5563;
    border-radius: 4px;
    background: #17191d;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
}
.bp-frame-info-header {
    flex: 0 0 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 0 10px;
    border-bottom: 1px solid #30343b;
    color: #f4f4f5;
    font-size: 12px;
    font-weight: 600;
}
.bp-frame-info-header button {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #cfd3da;
    cursor: pointer;
    font-size: 18px;
    line-height: 20px;
}
.bp-frame-info-header button:hover {
    background: #30343b;
    color: #fff;
}
.bp-frame-info-text {
    flex: 1 1 auto;
    min-height: 120px;
    margin: 0;
    padding: 10px 12px;
    overflow: auto;
    color: #d4d4d8;
    background: #101113;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: pre;
}
.bp-frame-tracker input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
}
`;
    document.head.appendChild(style);
})();
