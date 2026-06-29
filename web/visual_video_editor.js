import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { applyZhLabels } from "./shared_utils.js";

const NODE_CLASS = "BrotherPao_VisualVideoEditor";
const DOM_WIDGET_NAME = "bp_visual_video_editor";
const DEFAULT_SIZE = [520, 620];
const MIN_EDITOR_HEIGHT = 360;
const STATE_VERSION = 2;
const DEFAULT_DIVISOR = 16;
const DEFAULT_PREVIEW_FRAMES = 1;
const DIVISOR_MIN = 4;
const DIVISOR_MAX = 128;
const DIMENSION_MIN = 320;
const DIMENSION_MAX = 4096;
const FPS_MIN = 8;
const FPS_MAX = 128;
const IMAGE_FRAMES_MIN = 1;
const IMAGE_FRAMES_MAX = 1000;
const MAX_NATIVE_SLIDER_STEPS = 100;
const PREVIEW_KEYS = ["image", "images", "video", "videos", "gifs", "animated", "preview", "previews", "media"];
const INPUT_WIDGET_NAMES = new Set(["file", "width", "height", "divisor", "fps", "preview_frames", "state"]);
const NATIVE_PREVIEW_WIDGET_NAMES = new Set(["video-preview", "$$comfy_animation_preview"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".flv", ".wmv", ".mpeg", ".mpg"]);
const VISUAL_VIDEO_EDITOR_LABELS = {
    file: "视频",
    width: "宽度",
    height: "高度",
    divisor: "整除数",
    fps: "帧率",
    preview_frames: "图像帧数",
    state: "编辑状态",
    video: "视频",
    images: "图像",
    frame_count: "帧数",
    crop_info: "裁剪信息",
};
const ICONS = {
    play: `<svg viewBox="0 0 24 24"><path class="play" d="M8 5v14l11-7z"/><path class="pause" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>`,
    reset: `<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M3 12a9 9 0 1 0 3-6.7M3 4v6h6"/></svg>`,
    locked: `<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z"/></svg>`,
    unlocked: `<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M8 10V8a5 5 0 0 1 9.2-2.7M6 10h12v10H6z"/></svg>`,
};
const instances = new WeakMap();

function isVideoFilename(filename) {
    const lower = String(filename || "").toLowerCase().split("?")[0];
    return [...VIDEO_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

function ensureVideoViewChannel(url) {
    const value = String(url || "");
    const queryStart = value.indexOf("?");
    if (queryStart < 0) return url;

    const path = value.slice(0, queryStart);
    if (!path.endsWith("/view")) return url;

    const params = new URLSearchParams(value.slice(queryStart + 1));
    if (params.has("channel") || params.has("preview") || !isVideoFilename(params.get("filename"))) return url;

    params.set("channel", "other");
    return `${path}?${params.toString()}`;
}

function installVideoViewUrlPatch() {
    if (api._bpVideoViewUrlPatchInstalled || typeof api.apiURL !== "function") return;
    api._bpVideoViewUrlPatchInstalled = true;
    const original = api.apiURL.bind(api);
    api.apiURL = function (url) {
        return original(ensureVideoViewChannel(url));
    };
}

installVideoViewUrlPatch();

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

function widget(node, name) {
    return node.widgets?.find((item) => item.name === name) || null;
}

function widgetNumber(node, name, fallback = 0) {
    const value = Number(widget(node, name)?.value);
    return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
    const safe = Number(value);
    if (!Number.isFinite(safe)) return min;
    return Math.max(min, Math.min(max, safe));
}

function widgetInputNumber(node, name, inputValue, fallback = 0) {
    const value = Number(inputValue);
    return Number.isFinite(value) ? value : widgetNumber(node, name, fallback);
}

function syncWidgetElementValue(item, value) {
    const elements = [item?.inputEl, item?.element, item?.domElement];
    for (const element of elements) {
        if (element && "value" in element && element.value !== String(value)) {
            element.value = String(value);
        }
    }
}

function setWidgetSliderVisualMode(node, item, min, max) {
    item.options = item.options || {};
    const changed = item.options.min !== min
        || item.options.max !== max
        || item.options.display !== "slider"
        || item.options.slider !== true
        || item.min !== min
        || item.max !== max
        || item.min_value !== min
        || item.max_value !== max
        || item.display !== "slider"
        || item.slider !== true;
    item.options.min = min;
    item.options.max = max;
    item.options.display = "slider";
    item.options.slider = true;
    item.min = min;
    item.max = max;
    item.min_value = min;
    item.max_value = max;
    item.display = "slider";
    item.slider = true;
    if (item.inputEl) {
        item.inputEl.min = String(min);
        item.inputEl.max = String(max);
    }
    if (changed) markDirty(node);
}

function setWidgetValue(node, name, value) {
    const item = widget(node, name);
    if (!item) return;
    item._bpCommittedValue = value;
    if (item.value !== value) {
        item.value = value;
        syncWidgetElementValue(item, value);
        markDirty(node);
    } else {
        syncWidgetElementValue(item, value);
    }
}

function setWidgetRange(node, name, min, max) {
    const item = widget(node, name);
    if (!item) return;
    setWidgetSliderVisualMode(node, item, min, max);
}

function sliderDisplayStep(min, max, interactionStep) {
    const range = Math.max(1, Number(max) - Number(min));
    const minimumDisplayStep = Math.ceil(range / MAX_NATIVE_SLIDER_STEPS);
    return Math.max(Number(interactionStep) || 1, minimumDisplayStep);
}

function setWidgetStep(node, name, interactionStep, round = true, displayStep = interactionStep) {
    const item = widget(node, name);
    if (!item) return;
    const rawInteractionStep = Number(interactionStep) || 1;
    const rawDisplayStep = Number(displayStep) || rawInteractionStep;
    const safeInteractionStep = round ? Math.max(1, Math.round(rawInteractionStep)) : Math.max(0.001, rawInteractionStep);
    const safeDisplayStep = round ? Math.max(1, Math.round(rawDisplayStep)) : Math.max(0.001, rawDisplayStep);
    item.options = item.options || {};
    delete item.options.round;
    delete item.round;
    const currentStep = Number(item.step);
    const currentStep2 = Number(item.step2);
    const currentOptionStep = Number(item.options?.step);
    const currentOptionStep2 = Number(item.options?.step2);
    if (
        Number.isFinite(currentStep)
        && currentStep === safeDisplayStep
        && Number.isFinite(currentStep2)
        && currentStep2 === safeInteractionStep
        && Number.isFinite(currentOptionStep)
        && currentOptionStep === safeDisplayStep
        && Number.isFinite(currentOptionStep2)
        && currentOptionStep2 === safeInteractionStep
    ) {
        if (item.inputEl && item.inputEl.step !== String(safeInteractionStep)) item.inputEl.step = String(safeInteractionStep);
        return;
    }
    item.step = safeDisplayStep;
    item.step2 = safeInteractionStep;
    item.options.step = safeDisplayStep;
    item.options.step2 = safeInteractionStep;
    if (item.inputEl) item.inputEl.step = String(safeInteractionStep);
    markDirty(node);
}

function syncDimensionWidgetSteps(node, inputValue = undefined) {
    const step = divisor(node, inputValue);
    setWidgetValue(node, "divisor", step);
    setWidgetRange(node, "width", DIMENSION_MIN, DIMENSION_MAX);
    setWidgetRange(node, "height", DIMENSION_MIN, DIMENSION_MAX);
    const displayStep = sliderDisplayStep(DIMENSION_MIN, DIMENSION_MAX, step);
    setWidgetStep(node, "width", step, true, displayStep);
    setWidgetStep(node, "height", step, true, displayStep);
}

function applyWidgetConstraints(node) {
    setWidgetRange(node, "divisor", DIVISOR_MIN, DIVISOR_MAX);
    setWidgetStep(node, "divisor", 1, true, sliderDisplayStep(DIVISOR_MIN, DIVISOR_MAX, 1));
    setWidgetRange(node, "fps", FPS_MIN, FPS_MAX);
    setWidgetStep(node, "fps", 0.01, false, sliderDisplayStep(FPS_MIN, FPS_MAX, 0.01));
    setWidgetRange(node, "preview_frames", IMAGE_FRAMES_MIN, IMAGE_FRAMES_MAX);
    setWidgetStep(node, "preview_frames", 1, true, sliderDisplayStep(IMAGE_FRAMES_MIN, IMAGE_FRAMES_MAX, 1));
    syncDimensionWidgetSteps(node);
}

function installWidgetCallback(item, callback) {
    if (!item || item._bpVideoCallbackInstalled) return;
    item._bpVideoCallbackInstalled = true;
    const original = item.callback;
    item.callback = function () {
        const result = original?.apply(this, arguments);
        const callbackArgs = arguments.length ? arguments : [this?.value ?? item.value];
        callback.apply(this, callbackArgs);
        return result;
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

function formatTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}

function formatFrameCount(frames) {
    const count = Math.max(0, Math.round(Number(frames) || 0));
    return locale() === "zh" ? `${count}帧` : `${count} ${count === 1 ? "frame" : "frames"}`;
}

function applyVisualVideoEditorLabels(node) {
    applyZhLabels(node, VISUAL_VIDEO_EDITOR_LABELS);
    for (const output of node.outputs || []) {
        const label = VISUAL_VIDEO_EDITOR_LABELS[output.name] || VISUAL_VIDEO_EDITOR_LABELS[output.label] || VISUAL_VIDEO_EDITOR_LABELS[output.localized_name];
        if (!label) continue;
        output.label = label;
        output.localized_name = label;
    }
}

function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function consume(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
}

function annotatedFileParts(value) {
    let name = String(value || "").trim();
    if (!name) return null;

    let type = "input";
    const suffixes = [
        ["[output]", "output"],
        ["[input]", "input"],
        ["[temp]", "temp"],
    ];
    for (const [suffix, suffixType] of suffixes) {
        if (name.endsWith(suffix)) {
            type = suffixType;
            name = name.slice(0, -suffix.length).trim();
            break;
        }
    }

    name = name.replace(/\\/g, "/");
    const parts = name.split("/");
    const filename = parts.pop();
    return { filename, subfolder: parts.join("/"), type };
}

function videoUrl(file) {
    const parts = annotatedFileParts(file);
    if (!parts?.filename) return "";
    const params = new URLSearchParams({
        filename: parts.filename,
        type: parts.type,
        subfolder: parts.subfolder || "",
        channel: "other",
        rand: String(Date.now()),
    });
    return api.apiURL(`/view?${params.toString()}`);
}

async function fetchMetadata(file) {
    const params = new URLSearchParams({ file });
    const response = await fetch(api.apiURL(`/brotherpao/video_metadata?${params.toString()}`));
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.error || response.statusText);
    }
    return payload;
}

function readState(node) {
    const raw = widget(node, "state")?.value;
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
        return null;
    }
}

function storedStateFile(node) {
    const value = readState(node)?.source?.file;
    return typeof value === "string" ? value : "";
}

function videoFileForLoad(node, instance) {
    const currentFile = widget(node, "file")?.value || "";
    const savedFile = storedStateFile(node);
    if (!instance?.metadata && !instance?.requestedFile && savedFile) {
        if (currentFile !== savedFile) setWidgetValue(node, "file", savedFile);
        return savedFile;
    }
    return currentFile;
}

function writeState(node, instance) {
    if (!instance.metadata) return;
    const output = outputSize(node, instance);
    const state = {
        version: STATE_VERSION,
        source: {
            file: widget(node, "file")?.value || "",
            width: instance.metadata.width,
            height: instance.metadata.height,
            duration: instance.metadata.duration,
            fps: instance.metadata.fps,
            frame_count: instance.metadata.frame_count,
        },
        output: {
            width: output.width,
            height: output.height,
            fps: outputFps(node, instance),
            divisor: divisor(node),
            preview_frames: Math.round(clamp(widgetNumber(node, "preview_frames", DEFAULT_PREVIEW_FRAMES), IMAGE_FRAMES_MIN, IMAGE_FRAMES_MAX)),
            dimension_auto_scale_used: Boolean(instance.dimensionAutoScaleUsed),
            settings_locked: Boolean(instance.outputSettingsLocked),
        },
        crop: clone(instance.crop),
        timeline: clone(instance.timeline),
    };
    setWidgetValue(node, "state", JSON.stringify(state));
}

function applyStoredOutputWidgets(node, stored) {
    if (stored?.version !== STATE_VERSION || !stored.output) return false;
    const output = stored.output;
    const storedDivisor = Number(output.divisor);
    const div = Math.round(clamp(Number.isFinite(storedDivisor) ? storedDivisor : DEFAULT_DIVISOR, DIVISOR_MIN, DIVISOR_MAX));
    setWidgetValue(node, "divisor", div);
    applyWidgetConstraints(node);

    const width = Number(output.width);
    const height = Number(output.height);
    const fps = Number(output.fps);
    const frames = Number(output.preview_frames);
    if (Number.isFinite(width)) setWidgetValue(node, "width", alignOutputDimension(width, div));
    if (Number.isFinite(height)) setWidgetValue(node, "height", alignOutputDimension(height, div));
    if (Number.isFinite(fps)) setWidgetValue(node, "fps", Math.round(clamp(fps, FPS_MIN, FPS_MAX) * 1000) / 1000);
    if (Number.isFinite(frames)) {
        setWidgetValue(node, "preview_frames", Math.round(clamp(frames, IMAGE_FRAMES_MIN, IMAGE_FRAMES_MAX)));
    }
    return true;
}

function divisor(node, inputValue = undefined) {
    return Math.round(clamp(widgetInputNumber(node, "divisor", inputValue, DEFAULT_DIVISOR), DIVISOR_MIN, DIVISOR_MAX));
}

function alignDimension(value, div, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const raw = Math.max(1, Math.round(Number(value) || 1));
    if (div <= 1) return Math.round(clamp(raw, min, max));
    return Math.round(clamp(Math.max(div, Math.round(raw / div) * div), min, max));
}

function alignOutputDimension(value, div) {
    return alignDimension(value, div, DIMENSION_MIN, DIMENSION_MAX);
}

function snapOutputDimension(node, name, rawValue, div) {
    const item = widget(node, name);
    const previous = Number(item?._bpCommittedValue);
    let snapped = alignOutputDimension(rawValue, div);
    if (Number.isFinite(previous) && previous >= DIMENSION_MIN && previous <= DIMENSION_MAX) {
        if (rawValue > previous && snapped <= previous) {
            snapped = alignOutputDimension(previous + div, div);
        } else if (rawValue < previous && snapped >= previous) {
            snapped = alignOutputDimension(previous - div, div);
        }
    }
    return snapped;
}

function outputSize(node, instance) {
    const div = divisor(node);
    const fallbackWidth = instance.metadata?.width || 512;
    const fallbackHeight = instance.metadata?.height || 512;
    return {
        width: alignOutputDimension(widgetNumber(node, "width", fallbackWidth) || fallbackWidth, div),
        height: alignOutputDimension(widgetNumber(node, "height", fallbackHeight) || fallbackHeight, div),
    };
}

function outputWidgetRatio(node, instance) {
    const size = outputSize(node, instance);
    return Math.max(0.001, size.width / size.height);
}

function syncOutputRatio(node, instance) {
    if (!instance) return;
    instance.outputAspectRatio = outputWidgetRatio(node, instance);
}

function outputRatio(node, instance) {
    return Math.max(0.001, Number(instance?.outputAspectRatio) || outputWidgetRatio(node, instance));
}

function alignDownDimension(value, div) {
    const raw = Math.max(1, Math.floor(Number(value) || 1));
    if (div <= 1) return raw;
    return Math.max(div, Math.floor(raw / div) * div);
}

function fitCropSize(node, instance, desiredW, desiredH, maxW, maxH) {
    const div = divisor(node);
    const ratio = outputRatio(node, instance);
    const limitW = Math.max(1, Number(maxW) || 1);
    const limitH = Math.max(1, Number(maxH) || 1);
    const rawW = Math.max(1, Number(desiredW) || 1);
    const rawH = Math.max(1, Number(desiredH) || 1);
    const useWidth = rawW / rawH >= ratio;
    let w = useWidth ? alignDimension(rawW, div) : alignDimension(rawH * ratio, div);
    let h = alignDimension(w / ratio, div);

    if (w > limitW || h > limitH) {
        w = alignDownDimension(Math.min(limitW, limitH * ratio), div);
        h = alignDownDimension(w / ratio, div);
        while ((w > limitW || h > limitH) && w > div) {
            w = alignDownDimension(w - div, div);
            h = alignDownDimension(w / ratio, div);
        }
    }

    return {
        w: Math.max(1, Math.min(limitW, w)),
        h: Math.max(1, Math.min(limitH, h)),
    };
}

function normalizeCrop(node, instance, crop) {
    const meta = instance.metadata;
    if (!meta) return { x: 0, y: 0, w: 1, h: 1 };

    const centerX = Number(crop.x || 0) + Math.max(1, Number(crop.w || 1)) / 2;
    const centerY = Number(crop.y || 0) + Math.max(1, Number(crop.h || 1)) / 2;
    const { w, h } = fitCropSize(node, instance, Math.max(1, Number(crop.w || 1)), Math.max(1, Number(crop.h || 1)), meta.width, meta.height);
    const x = Math.max(0, Math.min(meta.width - w, centerX - w / 2));
    const y = Math.max(0, Math.min(meta.height - h, centerY - h / 2));
    return {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
    };
}

function defaultCrop(node, instance) {
    if (!instance.metadata) return { x: 0, y: 0, w: 1, h: 1 };
    const { w, h } = fitCropSize(node, instance, instance.metadata.width, instance.metadata.height, instance.metadata.width, instance.metadata.height);
    return normalizeCrop(node, instance, {
        x: (instance.metadata.width - w) / 2,
        y: (instance.metadata.height - h) / 2,
        w,
        h,
    });
}

function clampTimeline(instance, timeline) {
    const duration = Math.max(0, Number(instance.metadata?.duration) || 0);
    let start = Math.max(0, Math.min(duration, Number(timeline?.start) || 0));
    let end = Math.max(0, Math.min(duration, Number(timeline?.end) || duration));
    if (end <= start) {
        start = 0;
        end = duration;
    }
    return { start, end };
}

function sourcePoint(instance, event) {
    const rect = instance.stage.getBoundingClientRect();
    const meta = instance.metadata;
    return {
        x: Math.max(0, Math.min(meta.width, ((event.clientX - rect.left) / rect.width) * meta.width)),
        y: Math.max(0, Math.min(meta.height, ((event.clientY - rect.top) / rect.height) * meta.height)),
    };
}

function outputDuration(instance) {
    if (!instance?.metadata || !instance.timeline) return 0;
    return Math.max(0, Number(instance.timeline.end || 0) - Number(instance.timeline.start || 0));
}

function outputFps(node, instance) {
    return clamp(widgetNumber(node, "fps", 0) || Number(instance?.metadata?.fps) || FPS_MIN, FPS_MIN, FPS_MAX);
}

function updateOutputInfo(instance) {
    if (!instance?.rightInfo) return;
    if (!instance.metadata || !instance.crop) {
        instance.rightInfo.textContent = "";
        instance.rightInfo.title = "";
        return;
    }

    const duration = outputDuration(instance);
    const frames = Math.max(1, Math.round(duration * outputFps(instance.node, instance)));
    const size = outputSize(instance.node, instance);
    const text = `${instance.crop.w} x ${instance.crop.h} (${instance.crop.x}, ${instance.crop.y}) -> ${size.width} x ${size.height} · ${formatFrameCount(frames)} · ${formatTime(duration)}`;
    instance.rightInfo.textContent = text;
    instance.rightInfo.title = text;
}

function updateLockButton(instance) {
    if (!instance?.lockBtn) return;
    const locked = Boolean(instance.outputSettingsLocked);
    const title = locked
        ? t("Unlock output settings and crop box", "解锁输出设置和裁剪框")
        : t("Lock output settings and crop box", "锁定输出设置和裁剪框");
    instance.container?.classList.toggle("locked", locked);
    instance.lockBtn.classList.toggle("locked", locked);
    instance.lockBtn.title = title;
    instance.lockBtn.setAttribute("aria-label", title);
    instance.lockBtn.innerHTML = locked ? ICONS.locked : ICONS.unlocked;
}

function setOutputSettingsLocked(node, instance, locked, persist = true) {
    if (!instance) return;
    instance.outputSettingsLocked = Boolean(locked);
    updateLockButton(instance);
    if (persist && instance.metadata) writeState(node, instance);
    markDirty(node);
}

function updateCropElement(instance) {
    if (!instance.metadata || !instance.crop) {
        instance.cropBox.hidden = true;
        updateOutputInfo(instance);
        return;
    }
    const { width, height } = instance.metadata;
    instance.cropBox.hidden = false;
    instance.cropBox.style.left = `${(instance.crop.x / width) * 100}%`;
    instance.cropBox.style.top = `${(instance.crop.y / height) * 100}%`;
    instance.cropBox.style.width = `${(instance.crop.w / width) * 100}%`;
    instance.cropBox.style.height = `${(instance.crop.h / height) * 100}%`;
    updateOutputInfo(instance);
}

function updateTimeline(instance) {
    const duration = Math.max(0.001, Number(instance.metadata?.duration) || 0.001);
    const startPct = (instance.timeline.start / duration) * 100;
    const endPct = (instance.timeline.end / duration) * 100;
    instance.rangeFill.style.left = `${startPct}%`;
    instance.rangeFill.style.right = `${Math.max(0, 100 - endPct)}%`;
    instance.startHandle.style.left = `${startPct}%`;
    instance.endHandle.style.left = `${endPct}%`;
    instance.timeInfo.textContent = `${formatTime(instance.timeline.start)} - ${formatTime(instance.timeline.end)} / ${formatTime(duration)}`;
    updateOutputInfo(instance);
}

function updateStage(instance) {
    const meta = instance.metadata;
    if (!meta) {
        instance.stage.style.aspectRatio = "16 / 9";
        updateOutputInfo(instance);
        return;
    }
    instance.stage.style.aspectRatio = `${meta.width} / ${meta.height}`;
    updateCropElement(instance);
    updateTimeline(instance);
}

function updateStatus(instance, text) {
    instance.status.textContent = text || "";
    instance.status.hidden = !text;
}

function stripAutoPreviewOutput(output) {
    if (!output || typeof output !== "object") return output;
    const cleaned = Array.isArray(output) ? [...output] : { ...output };
    for (const key of PREVIEW_KEYS) {
        delete cleaned[key];
    }
    if (cleaned.ui && typeof cleaned.ui === "object") {
        cleaned.ui = { ...cleaned.ui };
        for (const key of PREVIEW_KEYS) {
            delete cleaned.ui[key];
        }
    }
    return cleaned;
}

function isVisualVideoNode(node) {
    return node?.constructor?.comfyClass === NODE_CLASS
        || node?.comfyClass === NODE_CLASS
        || node?.type === NODE_CLASS;
}

function removeStoreEntryForNode(store, node) {
    if (!store || !node?.id) return;
    const nodeId = String(node.id);
    for (const key of Object.keys(store)) {
        if (key === nodeId || key.endsWith(`:${nodeId}`)) {
            delete store[key];
        }
    }
}

function clearNodePreviewState(node) {
    if (!node) return;
    node.imgs = undefined;
    node.images = undefined;
    node.imageIndex = null;
    node.animatedImages = undefined;
    node.videos = undefined;
    node.videoIndex = null;
    node.videoContainer = undefined;
    node.previewMediaType = undefined;
    node.isLoading = false;
    node.media = undefined;
    node.preview = undefined;
    node.previewImages = undefined;
    node.outputImages = undefined;
    node.outputVideos = undefined;

    removeStoreEntryForNode(app.nodeOutputs, node);
    removeStoreEntryForNode(app.nodePreviewImages, node);
}

function hideElement(element) {
    if (!element?.style) return;
    element.style.setProperty("display", "none", "important");
    element.style.setProperty("height", "0", "important");
    element.style.setProperty("min-height", "0", "important");
    element.style.setProperty("max-height", "0", "important");
    element.style.setProperty("overflow", "hidden", "important");
    element.setAttribute?.("aria-hidden", "true");
}

function hideWidgetShape(item) {
    item.hidden = true;
    item.serialize = false;
    item.computeSize = () => [0, 0];
    item.getHeight = () => 0;
    item.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0, maxHeight: 0, maxWidth: 0 });
    item.computedHeight = 0;
}

function hideMediaDescendants(element, instance) {
    if (!element) return false;
    const candidates = [];
    if (element.matches?.("video,img,canvas")) candidates.push(element);
    candidates.push(...(element.querySelectorAll?.("video,img,canvas") || []));

    let hidden = false;
    for (const candidate of candidates) {
        if (instance?.container?.contains(candidate)) continue;
        hideElement(candidate);
        hidden = true;
    }
    return hidden;
}

function removeNativePreviewWidgets(node) {
    if (!node?.widgets?.length) return;
    for (let i = node.widgets.length - 1; i >= 0; i--) {
        const item = node.widgets[i];
        const isNativePreview = NATIVE_PREVIEW_WIDGET_NAMES.has(item.name)
            || (item.name === "file" && item.type === "button")
            || (item.name === "file" && item.type === "custom");
        if (!isNativePreview) continue;

        const element = item.element || item.inputEl || item.domElement;
        hideMediaDescendants(element, instances.get(node));
        hideElement(element);
        item.onRemove?.();
        node.widgets.splice(i, 1);
    }
}

function suppressAutoPreview(node) {
    if (!isVisualVideoNode(node)) return;
    const instance = instances.get(node);
    removeNativePreviewWidgets(node);
    clearNodePreviewState(node);

    for (const item of node.widgets || []) {
        if (item === instance?.widget || item.name === DOM_WIDGET_NAME) continue;
        const element = item.element || item.inputEl || item.domElement;
        const hasMedia = hideMediaDescendants(element, instance);
        const rootIsMedia = /^(VIDEO|IMG|CANVAS)$/.test(element?.tagName || "");
        const isInputWidget = INPUT_WIDGET_NAMES.has(item.name);
        const looksLikePreview = !isInputWidget && /preview|image|video|media|output|animation/i.test(`${item.name || ""} ${item.type || ""}`);
        if (!hasMedia && !looksLikePreview && !rootIsMedia) continue;
        if (!isInputWidget || rootIsMedia || looksLikePreview) {
            hideWidgetShape(item);
            hideElement(element);
        }
    }
}

function scheduleSuppressAutoPreview(node) {
    suppressAutoPreview(node);
    requestAnimationFrame(() => suppressAutoPreview(node));
    setTimeout(() => suppressAutoPreview(node), 50);
    setTimeout(() => suppressAutoPreview(node), 250);
    setTimeout(() => suppressAutoPreview(node), 1000);
    setTimeout(() => suppressAutoPreview(node), 2000);
}

function wrapExecutedHandler(target, flagName) {
    if (!target || target[flagName]) return;
    target[flagName] = true;
    const original = target.onExecuted;
    target.onExecuted = function (output) {
        const shouldSuppress = isVisualVideoNode(this);
        const result = original?.call(this, shouldSuppress ? stripAutoPreviewOutput(output) : output);
        if (shouldSuppress) scheduleSuppressAutoPreview(this);
        return result;
    };
}

function replaceWidgetCallback(item, callback) {
    if (!item || item._bpVideoCallbackReplaced) return;
    item._bpVideoCallbackReplaced = true;
    item.callback = function () {
        callback.apply(this, arguments);
    };
}

function graphNodeById(id) {
    const graph = app.graph || app.canvas?.graph;
    if (!graph || id == null) return null;
    return graph.getNodeById?.(id) || graph._nodes_by_id?.[id] || graph._nodes_by_id?.[String(id)] || null;
}

function installExecutedEventFilter() {
    if (installExecutedEventFilter.installed) return;
    installExecutedEventFilter.installed = true;
    api.addEventListener?.("executed", (event) => {
        const detail = event?.detail;
        const node = graphNodeById(detail?.display_node ?? detail?.node) || graphNodeById(detail?.node);
        if (!isVisualVideoNode(node)) return;
        detail.output = stripAutoPreviewOutput(detail.output);
        scheduleSuppressAutoPreview(node);
    }, { capture: true });
}

function applyStoredOrDefaultState(node, instance, forceDefault = false, fallbackCrop = null) {
    syncOutputRatio(node, instance);
    const stored = readState(node);
    const sameFile = stored?.source?.file === widget(node, "file")?.value;
    if (!forceDefault && sameFile && stored?.version === STATE_VERSION && stored?.crop) {
        instance.dimensionAutoScaleUsed = Boolean(stored.output?.dimension_auto_scale_used);
        instance.outputSettingsLocked = Boolean(stored.output?.settings_locked);
        instance.crop = normalizeCrop(node, instance, stored.crop);
        instance.timeline = clampTimeline(instance, stored.timeline);
    } else {
        if (forceDefault) instance.outputSettingsLocked = false;
        instance.dimensionAutoScaleUsed = false;
        instance.crop = !forceDefault && instance.outputSettingsLocked && fallbackCrop
            ? normalizeCrop(node, instance, fallbackCrop)
            : defaultCrop(node, instance);
        instance.timeline = { start: 0, end: Math.max(0, Number(instance.metadata.duration) || 0) };
    }
    updateLockButton(instance);
    writeState(node, instance);
}

function sourceOutputDefaults(node, instance) {
    const div = divisor(node);
    return {
        width: alignOutputDimension(instance.metadata.width, div),
        height: alignOutputDimension(instance.metadata.height, div),
        fps: Math.round(clamp(Number(instance.metadata.fps) || FPS_MIN, FPS_MIN, FPS_MAX) * 1000) / 1000,
    };
}

function setDefaultOutputWidgets(node, instance, resetDivisor = false) {
    if (!instance?.metadata) return;
    if (resetDivisor) setWidgetValue(node, "divisor", DEFAULT_DIVISOR);
    instance.dimensionAutoScaleUsed = false;
    applyWidgetConstraints(node);
    const defaults = sourceOutputDefaults(node, instance);
    setWidgetValue(node, "width", defaults.width);
    setWidgetValue(node, "height", defaults.height);
    setWidgetValue(node, "fps", defaults.fps);
    syncOutputRatio(node, instance);
}

function shouldUseSourceOutputDefaults(node, instance, forceDefaults, hadLoadedVideo = false) {
    if (forceDefaults || widgetNumber(node, "width", 0) <= 0 || widgetNumber(node, "height", 0) <= 0) return true;
    if (instance?.outputSettingsLocked) return false;
    if (hadLoadedVideo) return true;

    const stored = readState(node);
    if (stored?.version === STATE_VERSION && stored?.source?.file === widget(node, "file")?.value) return false;

    return widgetNumber(node, "width", 0) === DIMENSION_MIN
        && widgetNumber(node, "height", 0) === DIMENSION_MIN
        && widgetNumber(node, "fps", 0) === FPS_MIN;
}

function applyDivisorSettings(node, instance, inputValue = undefined) {
    if (!instance?.metadata) return;
    setWidgetValue(node, "divisor", divisor(node, inputValue));
    applyWidgetConstraints(node);
    const size = outputSize(node, instance);
    setWidgetValue(node, "width", size.width);
    setWidgetValue(node, "height", size.height);
    syncOutputRatio(node, instance);
    instance.crop = normalizeCrop(node, instance, instance.crop || defaultCrop(node, instance));
    updateCropElement(instance);
    writeState(node, instance);
    markDirty(node);
}

function commitDimensionEffects(node, instance) {
    if (!instance?.metadata) return;
    instance.dimensionFrame = null;
    instance.crop = normalizeCrop(node, instance, instance.crop || defaultCrop(node, instance));
    updateCropElement(instance);
    writeState(node, instance);
    markDirty(node);
}

function scheduleDimensionEffects(node, instance) {
    if (!instance?.metadata || instance.dimensionFrame) return;
    instance.dimensionFrame = requestAnimationFrame(() => commitDimensionEffects(node, instance));
}

function applyManualDimensionInput(node, instance, changed, inputValue) {
    if (!instance?.metadata) return;
    syncDimensionWidgetSteps(node);
    const div = divisor(node);
    const ratio = outputRatio(node, instance);
    const fallback = changed === "width" ? instance.metadata.width : instance.metadata.height;
    const rawValue = widgetInputNumber(node, changed, inputValue, fallback) || fallback;

    if (!instance.dimensionAutoScaleUsed) {
        if (changed === "width") {
            const width = snapOutputDimension(node, "width", rawValue, div);
            setWidgetValue(node, "width", width);
            setWidgetValue(node, "height", alignOutputDimension(width / ratio, div));
        } else {
            const height = snapOutputDimension(node, "height", rawValue, div);
            setWidgetValue(node, "height", height);
            setWidgetValue(node, "width", alignOutputDimension(height * ratio, div));
        }
        instance.dimensionAutoScaleUsed = true;
    } else if (changed === "width") {
        setWidgetValue(node, "width", snapOutputDimension(node, "width", rawValue, div));
    } else {
        setWidgetValue(node, "height", snapOutputDimension(node, "height", rawValue, div));
    }

    syncOutputRatio(node, instance);
    updateOutputInfo(instance);
    scheduleDimensionEffects(node, instance);
}

function resetEditorState(node, instance) {
    if (!instance?.metadata) return;
    setOutputSettingsLocked(node, instance, false, false);
    setDefaultOutputWidgets(node, instance, true);
    setWidgetValue(node, "preview_frames", DEFAULT_PREVIEW_FRAMES);
    instance.timeline = { start: 0, end: Math.max(0, Number(instance.metadata.duration) || 0) };
    instance.crop = defaultCrop(node, instance);
    instance.video.currentTime = instance.timeline.start;
    instance.video.pause();
    updateStage(instance);
    writeState(node, instance);
    markDirty(node);
}

async function loadVideo(node, instance, forceDefaults = false) {
    const file = videoFileForLoad(node, instance);
    if (!file) {
        instance.metadata = null;
        instance.crop = null;
        instance.requestedFile = "";
        updateStatus(instance, t("Select or upload a video", "选择或上传视频"));
        updateStage(instance);
        return;
    }

    const hadLoadedVideo = Boolean(instance.metadata);
    const previousCrop = instance.crop ? clone(instance.crop) : null;
    const currentToken = `${file}:${Date.now()}`;
    instance.requestedFile = file;
    instance.loadToken = currentToken;
    updateStatus(instance, t("Loading video metadata", "正在读取视频信息"));

    try {
        const metadata = await fetchMetadata(file);
        if (instance.loadToken !== currentToken) return;
        instance.metadata = metadata;
        applyWidgetConstraints(node);
        const stored = readState(node);
        const sameStoredFile = stored?.version === STATE_VERSION && stored?.source?.file === file;
        if (!forceDefaults && sameStoredFile) {
            applyStoredOutputWidgets(node, stored);
            instance.outputSettingsLocked = Boolean(stored.output?.settings_locked);
            updateLockButton(instance);
        }

        if (shouldUseSourceOutputDefaults(node, instance, forceDefaults, hadLoadedVideo)) {
            setDefaultOutputWidgets(node, instance, forceDefaults);
        } else {
            const size = outputSize(node, instance);
            setWidgetValue(node, "width", size.width);
            setWidgetValue(node, "height", size.height);
            if (widgetNumber(node, "fps", 0) <= 0) {
                setWidgetValue(node, "fps", Math.round(outputFps(node, instance) * 1000) / 1000);
            } else {
                setWidgetValue(node, "fps", Math.round(outputFps(node, instance) * 1000) / 1000);
            }
            setWidgetValue(node, "preview_frames", Math.round(clamp(widgetNumber(node, "preview_frames", DEFAULT_PREVIEW_FRAMES), IMAGE_FRAMES_MIN, IMAGE_FRAMES_MAX)));
        }

        applyStoredOrDefaultState(node, instance, forceDefaults, previousCrop);
        instance.video.src = videoUrl(file);
        instance.video.currentTime = instance.timeline.start || 0;
        instance.video.load();
        updateStatus(instance, "");
        updateStage(instance);
        markDirty(node);
    } catch (error) {
        console.error("[VisualVideoEditor] Failed to load video:", error);
        updateStatus(instance, error.message || t("Failed to load video", "视频加载失败"));
    }
}

function setPlayState(instance, isPlaying) {
    instance.playBtn.classList.toggle("playing", isPlaying);
    const title = isPlaying ? t("Pause", "暂停") : t("Play", "播放");
    instance.playBtn.title = title;
    instance.playBtn.setAttribute("aria-label", title);
}

function buildHandle(name) {
    const handle = document.createElement("div");
    handle.className = `bp-video-crop-handle ${name}`;
    handle.dataset.handle = name;
    return handle;
}

function makeIconButton(className, title, svg) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = svg;
    button.addEventListener("mousedown", consume);
    return button;
}

function resizeFromHandle(node, instance, handle, point) {
    const start = instance.drag.startCrop;
    const meta = instance.metadata;
    const ratio = outputRatio(node, instance);
    const dx = point.x - instance.drag.startPoint.x;
    const dy = point.y - instance.drag.startPoint.y;
    let desiredW = start.w;
    let desiredH = start.h;
    const changesWidth = handle.includes("e") || handle.includes("w");
    const changesHeight = handle.includes("n") || handle.includes("s");

    if (handle.includes("e")) desiredW = start.w + dx;
    if (handle.includes("w")) desiredW = start.w - dx;
    if (handle.includes("s")) desiredH = start.h + dy;
    if (handle.includes("n")) desiredH = start.h - dy;
    if (changesWidth && !changesHeight) desiredH = desiredW / ratio;
    if (changesHeight && !changesWidth) desiredW = desiredH * ratio;

    const centerX = start.x + start.w / 2;
    const centerY = start.y + start.h / 2;
    const maxW = handle.includes("w")
        ? start.x + start.w
        : handle.includes("e")
            ? meta.width - start.x
            : Math.max(1, 2 * Math.min(centerX, meta.width - centerX));
    const maxH = handle.includes("n")
        ? start.y + start.h
        : handle.includes("s")
            ? meta.height - start.y
            : Math.max(1, 2 * Math.min(centerY, meta.height - centerY));
    const size = fitCropSize(
        node,
        instance,
        desiredW,
        desiredH,
        maxW,
        maxH,
    );
    let x = start.x;
    let y = start.y;
    if (handle.includes("w")) x = start.x + start.w - size.w;
    else if (!handle.includes("e")) x = centerX - size.w / 2;
    if (handle.includes("n")) y = start.y + start.h - size.h;
    else if (!handle.includes("s")) y = centerY - size.h / 2;

    return {
        x: Math.round(Math.max(0, Math.min(meta.width - size.w, x))),
        y: Math.round(Math.max(0, Math.min(meta.height - size.h, y))),
        w: size.w,
        h: size.h,
    };
}

function installPointerHandlers(node, instance) {
    instance.stage.addEventListener("pointerdown", (event) => {
        if (!instance.metadata || event.button !== 0) return;
        if (instance.outputSettingsLocked) {
            consume(event);
            return;
        }
        consume(event);
        instance.stage.setPointerCapture?.(event.pointerId);

        const handle = event.target?.dataset?.handle;
        const point = sourcePoint(instance, event);
        if (handle) {
            instance.drag = { mode: "resize", handle, startPoint: point, startCrop: clone(instance.crop) };
        } else if (event.target === instance.cropBox || instance.cropBox.contains(event.target)) {
            instance.drag = { mode: "move", startPoint: point, startCrop: clone(instance.crop) };
        } else {
            instance.drag = { mode: "draw", startPoint: point, startCrop: null };
            instance.crop = normalizeCrop(node, instance, { x: point.x, y: point.y, w: 1, h: 1 });
            updateCropElement(instance);
        }
    });

    instance.stage.addEventListener("pointermove", (event) => {
        if (!instance.drag || !instance.metadata) return;
        consume(event);
        const point = sourcePoint(instance, event);
        if (instance.drag.mode === "move") {
            const dx = point.x - instance.drag.startPoint.x;
            const dy = point.y - instance.drag.startPoint.y;
            instance.crop = normalizeCrop(node, instance, {
                ...instance.drag.startCrop,
                x: instance.drag.startCrop.x + dx,
                y: instance.drag.startCrop.y + dy,
            });
        } else if (instance.drag.mode === "resize") {
            instance.crop = resizeFromHandle(node, instance, instance.drag.handle, point);
        } else if (instance.drag.mode === "draw") {
            instance.crop = normalizeCrop(node, instance, {
                x: Math.min(instance.drag.startPoint.x, point.x),
                y: Math.min(instance.drag.startPoint.y, point.y),
                w: Math.abs(point.x - instance.drag.startPoint.x),
                h: Math.abs(point.y - instance.drag.startPoint.y),
            });
        }
        updateCropElement(instance);
    });

    const finish = (event) => {
        if (!instance.drag) return;
        consume(event);
        instance.drag = null;
        writeState(node, instance);
        markDirty(node);
    };
    instance.stage.addEventListener("pointerup", finish);
    instance.stage.addEventListener("pointercancel", finish);
}

function timeFromTrack(instance, event) {
    const rect = instance.rangeTrack.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return pct * Math.max(0, Number(instance.metadata?.duration) || 0);
}

function scheduleVideoLoad(node, instance, forceDefaults = false) {
    if (!instance || instance.scheduledLoadFrame) return;
    instance.scheduledLoadFrame = requestAnimationFrame(() => {
        instance.scheduledLoadFrame = null;
        loadVideo(node, instance, forceDefaults);
    });
}

function applyVideoSeek(instance, time, precise = false) {
    const duration = Math.max(0, Number(instance.metadata?.duration) || 0);
    const target = Math.max(0, Math.min(duration, Number(time) || 0));
    if (Math.abs((Number(instance.video.currentTime) || 0) - target) < 0.01) return;
    try {
        if (!precise && typeof instance.video.fastSeek === "function") instance.video.fastSeek(target);
        else instance.video.currentTime = target;
    } catch (_) {
        instance.video.currentTime = target;
    }
}

function scheduleVideoSeek(instance, time) {
    instance.pendingSeekTime = time;
    if (instance.seekFrame) return;
    instance.seekFrame = requestAnimationFrame(() => {
        instance.seekFrame = null;
        const target = instance.pendingSeekTime;
        instance.pendingSeekTime = null;
        applyVideoSeek(instance, target);
    });
}

function flushVideoSeek(instance) {
    if (instance.seekFrame) {
        cancelAnimationFrame(instance.seekFrame);
        instance.seekFrame = null;
    }
    if (instance.pendingSeekTime != null) {
        const target = instance.pendingSeekTime;
        instance.pendingSeekTime = null;
        applyVideoSeek(instance, target, true);
    }
}

function installTimelineHandlers(node, instance) {
    const beginDrag = (kind, event) => {
        if (!instance.metadata) return;
        consume(event);
        instance.rangeTrack.setPointerCapture?.(event.pointerId);
        instance.rangeDrag = kind;
        instance.video.pause();
    };
    instance.startHandle.addEventListener("pointerdown", (event) => beginDrag("start", event));
    instance.endHandle.addEventListener("pointerdown", (event) => beginDrag("end", event));
    instance.rangeTrack.addEventListener("pointerdown", (event) => {
        if (event.target === instance.startHandle || event.target === instance.endHandle) return;
        const time = timeFromTrack(instance, event);
        const startDistance = Math.abs(time - instance.timeline.start);
        const endDistance = Math.abs(time - instance.timeline.end);
        beginDrag(startDistance <= endDistance ? "start" : "end", event);
        updateTimelineDrag(node, instance, event);
    });
    instance.rangeTrack.addEventListener("pointermove", (event) => {
        if (!instance.rangeDrag) return;
        updateTimelineDrag(node, instance, event);
    });
    const endDrag = (event) => {
        if (!instance.rangeDrag) return;
        consume(event);
        flushVideoSeek(instance);
        instance.rangeDrag = null;
        writeState(node, instance);
        markDirty(node);
    };
    instance.rangeTrack.addEventListener("pointerup", endDrag);
    instance.rangeTrack.addEventListener("pointercancel", endDrag);
}

function updateTimelineDrag(node, instance, event) {
    const duration = Math.max(0, Number(instance.metadata?.duration) || 0);
    const time = timeFromTrack(instance, event);
    const minGap = Math.min(0.05, duration / 100);
    let previewTime;
    if (instance.rangeDrag === "start") {
        instance.timeline.start = Math.max(0, Math.min(time, instance.timeline.end - minGap));
        previewTime = instance.timeline.start;
    } else {
        instance.timeline.end = Math.min(duration, Math.max(time, instance.timeline.start + minGap));
        previewTime = instance.timeline.end;
    }
    updateTimeline(instance);
    scheduleVideoSeek(instance, previewTime);
}

function buildEditor(node) {
    const container = document.createElement("div");
    container.className = "bp-video-editor";

    const toolbar = document.createElement("div");
    toolbar.className = "bp-video-toolbar";
    container.appendChild(toolbar);

    const leftTools = document.createElement("div");
    leftTools.className = "bp-video-tools";
    toolbar.appendChild(leftTools);

    const playBtn = makeIconButton("bp-video-btn", t("Play", "播放"), ICONS.play);
    const resetBtn = makeIconButton("bp-video-btn", t("Reset State", "重置所有状态"), ICONS.reset);
    const lockBtn = makeIconButton("bp-video-btn bp-video-lock-btn", t("Lock output settings", "锁定输出设置"), ICONS.unlocked);
    const rightInfo = document.createElement("div");
    rightInfo.className = "bp-video-meta";
    leftTools.append(playBtn, rightInfo, resetBtn, lockBtn);

    const stage = document.createElement("div");
    stage.className = "bp-video-stage";
    container.appendChild(stage);

    const video = document.createElement("video");
    video.muted = false;
    video.volume = 1;
    video.playsInline = true;
    video.preload = "metadata";
    stage.appendChild(video);

    const cropBox = document.createElement("div");
    cropBox.className = "bp-video-crop-box";
    cropBox.hidden = true;
    for (const name of ["n", "e", "s", "w", "nw", "ne", "se", "sw"]) {
        cropBox.appendChild(buildHandle(name));
    }
    stage.appendChild(cropBox);

    const status = document.createElement("div");
    status.className = "bp-video-status";
    status.textContent = t("Select or upload a video", "选择或上传视频");
    stage.appendChild(status);

    const timelineEl = document.createElement("div");
    timelineEl.className = "bp-video-timeline";
    container.appendChild(timelineEl);

    const rangeRow = document.createElement("div");
    rangeRow.className = "bp-video-range-row";
    timelineEl.appendChild(rangeRow);

    const timeInfo = document.createElement("div");
    timeInfo.className = "bp-video-time-info";
    timeInfo.textContent = "0:00.00 - 0:00.00 / 0:00.00";
    rangeRow.appendChild(timeInfo);

    const rangeTrack = document.createElement("div");
    rangeTrack.className = "bp-video-range-track";
    rangeRow.appendChild(rangeTrack);

    const rangeFill = document.createElement("div");
    rangeFill.className = "bp-video-range-fill";
    rangeTrack.appendChild(rangeFill);

    const startHandle = document.createElement("div");
    startHandle.className = "bp-video-range-handle start";
    rangeTrack.appendChild(startHandle);

    const endHandle = document.createElement("div");
    endHandle.className = "bp-video-range-handle end";
    rangeTrack.appendChild(endHandle);

    const instance = {
        node,
        container,
        toolbar,
        rightInfo,
        playBtn,
        resetBtn,
        lockBtn,
        stage,
        video,
        cropBox,
        status,
        timelineEl,
        rangeTrack,
        rangeFill,
        startHandle,
        endHandle,
        timeInfo,
        widget: null,
        metadata: null,
        crop: null,
        timeline: { start: 0, end: 0 },
        drag: null,
        rangeDrag: null,
        seekFrame: null,
        pendingSeekTime: null,
        dimensionFrame: null,
        dimensionAutoScaleUsed: false,
        outputSettingsLocked: false,
        loadToken: null,
        requestedFile: "",
        scheduledLoadFrame: null,
    };
    updateLockButton(instance);

    playBtn.addEventListener("click", (event) => {
        consume(event);
        if (!instance.metadata) return;
        if (video.paused) {
            if (video.currentTime < instance.timeline.start || video.currentTime >= instance.timeline.end) {
                video.currentTime = instance.timeline.start;
            }
            video.play();
        } else {
            video.pause();
        }
    });
    resetBtn.addEventListener("click", (event) => {
        consume(event);
        if (!instance.metadata) return;
        resetEditorState(node, instance);
    });
    lockBtn.addEventListener("click", (event) => {
        consume(event);
        setOutputSettingsLocked(node, instance, !instance.outputSettingsLocked);
    });

    video.addEventListener("play", () => setPlayState(instance, true));
    video.addEventListener("pause", () => setPlayState(instance, false));
    video.addEventListener("timeupdate", () => {
        if (!instance.metadata || video.paused) return;
        if (video.currentTime >= instance.timeline.end) {
            video.currentTime = instance.timeline.start;
        }
    });
    video.addEventListener("loadedmetadata", () => {
        if (!instance.metadata && video.videoWidth && video.videoHeight) {
            instance.metadata = {
                width: video.videoWidth,
                height: video.videoHeight,
                duration: video.duration || 0,
                fps: widgetNumber(node, "fps", 0) || 0,
                frame_count: 0,
            };
            if (widgetNumber(node, "width", 0) <= 0 || widgetNumber(node, "height", 0) <= 0) {
                setDefaultOutputWidgets(node, instance, false);
            }
            applyStoredOrDefaultState(node, instance, false);
            updateStage(instance);
        }
    });

    installPointerHandlers(node, instance);
    installTimelineHandlers(node, instance);
    for (const element of [container, stage, cropBox, rangeTrack]) {
        element.addEventListener("contextmenu", consume, { capture: true });
    }

    instances.set(node, instance);
    updateStage(instance);
    scheduleVideoLoad(node, instance, false);
    return instance;
}

function updateWidgetHeight(node) {
    const instance = instances.get(node);
    if (!instance?.widget) return;
    suppressAutoPreview(node);
    const width = Math.max(260, node.size?.[0] || DEFAULT_SIZE[0]);
    const meta = instance.metadata;
    const previewHeight = meta ? (width - 24) * (meta.height / meta.width) : 260;
    const height = Math.max(MIN_EDITOR_HEIGHT, Math.min(760, previewHeight + 88));
    instance.container.style.height = `${height}px`;
}

function createWidget(node) {
    if (typeof node.addDOMWidget !== "function") return null;

    const instance = instances.get(node) || buildEditor(node);
    if (instance.widget && node.widgets?.includes(instance.widget)) return instance.widget;

    const widgetObject = node.addDOMWidget(DOM_WIDGET_NAME, "brotherpao-visual-video-editor", instance.container, {
        getMinHeight: () => MIN_EDITOR_HEIGHT,
        getHeight: () => instance.container.clientHeight || MIN_EDITOR_HEIGHT,
        hideOnZoom: false,
        serialize: false,
    });
    widgetObject.computeSize = (width) => {
        const meta = instance.metadata;
        const previewHeight = meta ? Math.max(180, (width - 24) * (meta.height / meta.width)) : 260;
        return [width, Math.max(MIN_EDITOR_HEIGHT, Math.min(760, previewHeight + 88))];
    };
    widgetObject.serialize = false;
    instance.widget = widgetObject;

    requestAnimationFrame(() => {
        updateWidgetHeight(node);
        markDirty(node);
    });
    return widgetObject;
}

function hideStateWidget(node) {
    const state = widget(node, "state");
    if (!state) return;
    state._bpVideoHidden = true;
    state.options = { ...(state.options || {}), hidden: true };
    state.hidden = true;
    state.visible = false;
    state.computeSize = () => [0, 0];
    state.getHeight = () => 0;
    state.computeLayoutSize = () => ({ minHeight: 0, minWidth: 0, maxHeight: 0, maxWidth: 0 });
    state.computedHeight = 0;
    state.draw = () => {};
    hideElement(state.element || state.inputEl || state.domElement);
    hideElement(state.element?.parentElement || state.inputEl?.parentElement || state.domElement?.parentElement);
}

function installInputWatchers(node) {
    if (node._bpVideoInputWatchersInstalled) return;
    node._bpVideoInputWatchersInstalled = true;
    replaceWidgetCallback(widget(node, "file"), () => loadVideo(node, instances.get(node), false));
    installWidgetCallback(widget(node, "width"), (value) => {
        applyManualDimensionInput(node, instances.get(node), "width", value);
    });
    installWidgetCallback(widget(node, "height"), (value) => {
        applyManualDimensionInput(node, instances.get(node), "height", value);
    });
    installWidgetCallback(widget(node, "divisor"), (value) => {
        applyDivisorSettings(node, instances.get(node), value);
    });
    installWidgetCallback(widget(node, "fps"), (value) => {
        const instance = instances.get(node);
        setWidgetValue(node, "fps", Math.round(clamp(widgetInputNumber(node, "fps", value, FPS_MIN), FPS_MIN, FPS_MAX) * 1000) / 1000);
        if (instance?.metadata) {
            updateOutputInfo(instance);
            writeState(node, instance);
        }
    });
    installWidgetCallback(widget(node, "preview_frames"), (value) => {
        setWidgetValue(node, "preview_frames", Math.round(clamp(widgetInputNumber(node, "preview_frames", value, DEFAULT_PREVIEW_FRAMES), IMAGE_FRAMES_MIN, IMAGE_FRAMES_MAX)));
    });
}

function installNodeHooks(node) {
    if (node._bpVideoHooksInstalled) return;
    node._bpVideoHooksInstalled = true;
    chainCallback(node, "onResize", function () {
        requestAnimationFrame(() => updateWidgetHeight(this));
    });
    const originalOnDrawBackground = node.onDrawBackground;
    node.onDrawBackground = function () {
        suppressAutoPreview(this);
        const result = originalOnDrawBackground?.apply(this, arguments);
        suppressAutoPreview(this);
        return result;
    };
    chainCallback(node, "onDrawForeground", function () {
        hideStateWidget(this);
        suppressAutoPreview(this);
        updateWidgetHeight(this);
        const instance = instances.get(this);
        const currentFile = widget(this, "file")?.value || storedStateFile(this);
        if (instance && currentFile && instance.metadata?.file !== currentFile && instance.requestedFile !== currentFile) {
            scheduleVideoLoad(this, instance, false);
        }
        updateOutputInfo(instance);
    });
    wrapExecutedHandler(node, "_bpVideoInstanceExecutedWrapped");
}

function initializeNode(node) {
    if (node._bpVisualVideoEditorInitialized) return;
    node._bpVisualVideoEditorInitialized = true;
    applyVisualVideoEditorLabels(node);
    applyWidgetConstraints(node);

    if (!node.size || node.size[0] < DEFAULT_SIZE[0] || node.size[1] < DEFAULT_SIZE[1]) {
        node.setSize?.([
            Math.max(node.size?.[0] || 0, DEFAULT_SIZE[0]),
            Math.max(node.size?.[1] || 0, DEFAULT_SIZE[1]),
        ]);
    }

    hideStateWidget(node);
    createWidget(node);
    installInputWatchers(node);
    installNodeHooks(node);
}

app.registerExtension({
    name: "ComfyUI_BrotherPao.VisualVideoEditor",

    nodeCreated(node) {
        if (node.constructor?.comfyClass !== NODE_CLASS && node.comfyClass !== NODE_CLASS) return;
        installExecutedEventFilter();
        initializeNode(node);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        installExecutedEventFilter();
        wrapExecutedHandler(nodeType.prototype, "_bpVideoPrototypeExecutedWrapped");
        chainCallback(nodeType.prototype, "onNodeCreated", function () {
            initializeNode(this);
        });
    },
});

(function injectCSS() {
    if (document.getElementById("bp-visual-video-editor-style")) return;
    const style = document.createElement("style");
    style.id = "bp-visual-video-editor-style";
    style.textContent = `
.bp-video-editor {
    width: 100%;
    min-height: 360px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 4px;
    background: #111316;
    color: #d7dbe3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.bp-video-toolbar {
    flex: 0 0 32px;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    box-sizing: border-box;
    padding: 0 6px;
    background: #24272d;
    border-bottom: 1px solid #333842;
}
.bp-video-tools {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
}
.bp-video-btn {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #d7dbe3;
    cursor: pointer;
    padding: 0;
}
.bp-video-btn:hover {
    background: #3a3f49;
    color: #fff;
}
.bp-video-btn.locked {
    background: #245a7a;
    color: #ffffff;
}
.bp-video-btn.locked:hover {
    background: #2f6f96;
}
.bp-video-btn svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
}
.bp-video-btn .pause {
    display: none;
}
.bp-video-btn.playing .play {
    display: none;
}
.bp-video-btn.playing .pause {
    display: block;
}
.bp-video-meta {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    color: #b9c0cc;
    font: 11px ui-monospace, SFMono-Regular, Consolas, monospace;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 4px;
}
.bp-video-stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 180px;
    margin: 6px;
    overflow: hidden;
    background: #08090b;
    touch-action: none;
}
.bp-video-stage video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: fill;
    display: block;
    z-index: 0;
}
.bp-video-crop-box {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid #26d2ff;
    background: transparent;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.48);
    cursor: move;
    z-index: 2;
}
.bp-video-editor.locked .bp-video-crop-box {
    cursor: default;
}
.bp-video-crop-box[hidden] {
    display: none;
}
.bp-video-crop-handle {
    position: absolute;
    width: 10px;
    height: 10px;
    border: 1px solid #071013;
    border-radius: 50%;
    background: #f4f7fb;
}
.bp-video-editor.locked .bp-video-crop-handle {
    cursor: default;
    opacity: 0.55;
}
.bp-video-crop-handle.n { top: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.bp-video-crop-handle.e { right: -6px; top: calc(50% - 5px); cursor: ew-resize; }
.bp-video-crop-handle.s { bottom: -6px; left: calc(50% - 5px); cursor: ns-resize; }
.bp-video-crop-handle.w { left: -6px; top: calc(50% - 5px); cursor: ew-resize; }
.bp-video-crop-handle.nw { left: -6px; top: -6px; cursor: nwse-resize; }
.bp-video-crop-handle.ne { right: -6px; top: -6px; cursor: nesw-resize; }
.bp-video-crop-handle.se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.bp-video-crop-handle.sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.bp-video-status {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    color: #d7dbe3;
    background: #0c0e11;
    font-size: 13px;
    text-align: center;
    pointer-events: none;
    z-index: 5;
}
.bp-video-status[hidden] {
    display: none;
}
.bp-video-timeline {
    flex: 0 0 36px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    padding: 8px;
    background: #1b1e23;
    border-top: 1px solid #333842;
}
.bp-video-time-info {
    flex: 0 0 155px;
    color: #b9c0cc;
    font: 11px ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: nowrap;
}
.bp-video-range-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.bp-video-range-track {
    position: relative;
    flex: 1 1 auto;
    height: 18px;
    min-width: 80px;
    cursor: pointer;
    touch-action: none;
}
.bp-video-range-track::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 8px;
    height: 3px;
    border-radius: 2px;
    background: #4a505c;
}
.bp-video-range-fill {
    position: absolute;
    top: 8px;
    height: 3px;
    border-radius: 2px;
    background: #26d2ff;
}
.bp-video-range-handle {
    position: absolute;
    top: 2px;
    width: 8px;
    height: 14px;
    margin-left: -4px;
    border-radius: 2px;
    background: #f4f7fb;
    box-shadow: 0 0 0 1px #111316;
    cursor: ew-resize;
}
`;
    document.head.appendChild(style);
})();
