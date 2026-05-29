import { app } from "../../scripts/app.js";
import { applyZhLabels } from "./shared_utils.js";

const ZH_LABEL_MAP = {
    "image_a": "原图",
    "image_b": "对比图",
};

const DEFAULT_NODE_SIZE = [532, 582];
const DOM_WIDGET_NAME = "bp_compare_view";
const DOM_WIDGET_HEIGHT = 420;

const domInstances = new WeakMap();

function dataUrlFromChunks(chunks) {
    if (!chunks) return null;
    const data = Array.isArray(chunks) ? chunks.join("") : chunks;
    return data ? "data:image/png;base64," + data : null;
}

function fitContain(srcW, srcH, maxW, maxH) {
    if (!srcW || !srcH || !maxW || !maxH) {
        return { x: 0, y: 0, w: 0, h: 0 };
    }
    const s = Math.min(maxW / srcW, maxH / srcH);
    const w = Math.max(1, Math.floor(srcW * s));
    const h = Math.max(1, Math.floor(srcH * s));
    return {
        x: Math.floor((maxW - w) / 2),
        y: Math.floor((maxH - h) / 2),
        w,
        h,
    };
}

function getDrawGeom(node) {
    const margin = 10;
    const topOffset = 40;
    return {
        drawX: margin,
        drawY: margin + topOffset,
        drawW: node.size[0] - margin * 2,
        drawH: node.size[1] - margin * 2 - topOffset,
    };
}

function markDirty(node) {
    node?.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function drawCompareFrame(node, ctx) {
    const geom = getDrawGeom(node);
    const dx = geom.drawX, dy = geom.drawY, dw = geom.drawW, dh = geom.drawH;

    ctx.fillStyle = "#111";
    ctx.fillRect(dx, dy, dw, dh);

    const rectA = fitContain(
        (node.imgA && node.imgA.width) || dw,
        (node.imgA && node.imgA.height) || dh,
        dw, dh
    );
    const rectB = fitContain(
        (node.imgB && node.imgB.width) || dw,
        (node.imgB && node.imgB.height) || dh,
        dw, dh
    );

    if (node.imgB) {
        ctx.drawImage(node.imgB, dx + rectB.x, dy + rectB.y, rectB.w, rectB.h);
    }

    if (node.imgA) {
        const splitX = dx + Math.floor(dw * node.sliderPos);

        ctx.save();
        ctx.beginPath();
        ctx.rect(dx, dy, splitX - dx, dh);
        ctx.clip();
        ctx.drawImage(node.imgA, dx + rectA.x, dy + rectA.y, rectA.w, rectA.h);
        ctx.restore();

        ctx.strokeStyle = "#00e0ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(splitX, dy);
        ctx.lineTo(splitX, dy + dh);
        ctx.stroke();

        if (node.hovered || node.dragging) {
            ctx.fillStyle = "#00e0ff";
            ctx.beginPath();
            ctx.arc(splitX, dy + dh / 2, 5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    ctx.fillStyle = "white";
    ctx.font = "bold 14px sans-serif";
    ctx.shadowColor = "black";
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.shadowBlur = 0;
    ctx.fillText("原图", dx + 8, dy + 20);
    ctx.fillText("对比图", dx + dw - 58, dy + 20);

    if (node.imgA && node.imgB) {
        ctx.font = "normal 10px sans-serif";
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
        ctx.fillText(node.imgA.width + "x" + node.imgA.height, dx + 8, dy + 34);
        ctx.textAlign = "right";
        ctx.fillText(node.imgB.width + "x" + node.imgB.height, dx + dw - 10, dy + 34);
        ctx.textAlign = "start";
    }
}

function updateDomSplit(instance) {
    const pct = Math.max(0, Math.min(100, instance.sliderPos * 100));
    instance.imgA.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    instance.divider.style.left = `${pct}%`;
    instance.handle.style.left = `${pct}%`;
}

function setDomSlider(instance, clientX) {
    const rect = instance.stage.getBoundingClientRect();
    if (!rect.width) return;
    instance.sliderPos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    updateDomSplit(instance);
}

function setDomImages(instance, output) {
    const srcA = dataUrlFromChunks(output?.b64_a);
    const srcB = dataUrlFromChunks(output?.b64_b);
    if (!srcA || !srcB) return false;

    instance.imgA.onload = () => {
        instance.sizeA.textContent = `${instance.imgA.naturalWidth}x${instance.imgA.naturalHeight}`;
    };
    instance.imgB.onload = () => {
        instance.sizeB.textContent = `${instance.imgB.naturalWidth}x${instance.imgB.naturalHeight}`;
    };

    instance.imgA.src = srcA;
    instance.imgB.src = srcB;
    instance.empty.hidden = true;
    updateDomSplit(instance);
    return true;
}

function createDomInstance(node) {
    const container = document.createElement("div");
    container.className = "bp-compare-container";

    const stage = document.createElement("div");
    stage.className = "bp-compare-stage";
    container.appendChild(stage);

    const imgB = document.createElement("img");
    imgB.className = "bp-compare-img bp-compare-img-b";
    imgB.alt = "对比图";
    stage.appendChild(imgB);

    const imgA = document.createElement("img");
    imgA.className = "bp-compare-img bp-compare-img-a";
    imgA.alt = "原图";
    stage.appendChild(imgA);

    const divider = document.createElement("div");
    divider.className = "bp-compare-divider";
    stage.appendChild(divider);

    const handle = document.createElement("div");
    handle.className = "bp-compare-handle";
    stage.appendChild(handle);

    const labelA = document.createElement("div");
    labelA.className = "bp-compare-label bp-compare-label-a";
    labelA.textContent = "原图";
    stage.appendChild(labelA);

    const labelB = document.createElement("div");
    labelB.className = "bp-compare-label bp-compare-label-b";
    labelB.textContent = "对比图";
    stage.appendChild(labelB);

    const sizeA = document.createElement("div");
    sizeA.className = "bp-compare-size bp-compare-size-a";
    stage.appendChild(sizeA);

    const sizeB = document.createElement("div");
    sizeB.className = "bp-compare-size bp-compare-size-b";
    stage.appendChild(sizeB);

    const empty = document.createElement("div");
    empty.className = "bp-compare-empty";
    empty.textContent = "运行节点后显示对比图";
    stage.appendChild(empty);

    const instance = {
        node,
        container,
        stage,
        imgA,
        imgB,
        divider,
        handle,
        sizeA,
        sizeB,
        empty,
        sliderPos: 0.5,
        dragging: false,
        widget: null,
    };

    const onPointerDown = (event) => {
        event.preventDefault();
        event.stopPropagation();
        instance.dragging = true;
        stage.setPointerCapture?.(event.pointerId);
        setDomSlider(instance, event.clientX);
        markDirty(node);
    };

    const onPointerMove = (event) => {
        if (!instance.dragging) return;
        event.preventDefault();
        event.stopPropagation();
        setDomSlider(instance, event.clientX);
    };

    const onPointerUp = (event) => {
        if (!instance.dragging) return;
        event.preventDefault();
        event.stopPropagation();
        instance.dragging = false;
        stage.releasePointerCapture?.(event.pointerId);
        markDirty(node);
    };

    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);
    stage.addEventListener("lostpointercapture", () => {
        instance.dragging = false;
    });

    updateDomSplit(instance);
    domInstances.set(node, instance);
    return instance;
}

function createDomWidget(node) {
    if (typeof node.addDOMWidget !== "function") return null;

    let instance = domInstances.get(node);
    if (!instance) instance = createDomInstance(node);

    if (instance.widget && node.widgets?.includes(instance.widget)) {
        return instance.widget;
    }

    const widget = node.addDOMWidget(DOM_WIDGET_NAME, "brotherpao-image-compare", instance.container, {
        getMinHeight: () => 260,
        getHeight: () => instance.container.clientHeight || DOM_WIDGET_HEIGHT,
        hideOnZoom: false,
        serialize: false,
    });

    widget.computeSize = () => [320, DOM_WIDGET_HEIGHT];
    widget.serialize = false;
    instance.widget = widget;

    if (!node._bpCompareResizePatched) {
        node._bpCompareResizePatched = true;
        const origOnResize = node.onResize?.bind(node);
        node.onResize = function () {
            origOnResize?.call(this);
            requestAnimationFrame(() => updateDomWidgetHeight(this));
        };
    }

    requestAnimationFrame(() => requestAnimationFrame(() => updateDomWidgetHeight(node)));
    return widget;
}

function updateDomWidgetHeight(node) {
    const instance = domInstances.get(node);
    if (!instance?.widget) return;

    let topOffset = 0;
    for (const widget of node.widgets || []) {
        if (widget === instance.widget) {
            topOffset = widget.last_y || 0;
            break;
        }
    }

    const available = Math.max(220, (node.size?.[1] || DEFAULT_NODE_SIZE[1]) - topOffset - 24);
    instance.container.style.height = `${available}px`;
    markDirty(node);
}

function installDomOnExecuted(node) {
    if (node._bpCompareDomExecutedInstalled) return;
    node._bpCompareDomExecutedInstalled = true;

    const origOnExecuted = node.onExecuted;
    node.onExecuted = function (output) {
        origOnExecuted?.call(this, output);
        const instance = domInstances.get(this);
        if (instance && setDomImages(instance, output)) {
            markDirty(this);
        }
    };
}

function installCanvasFallback(node) {
    if (node._bpCompareCanvasFallbackInstalled) return;
    node._bpCompareCanvasFallbackInstalled = true;

    node.sliderPos = node.sliderPos ?? 0.5;
    node.dragging = false;
    node.hovered = false;

    const origOnMouseDown = node.onMouseDown;
    node.onMouseDown = function (event, pos) {
        const geom = getDrawGeom(this);
        const x = pos[0] - geom.drawX;
        const y = pos[1] - geom.drawY;
        if (x < 0 || x > geom.drawW || y < 0 || y > geom.drawH) {
            return origOnMouseDown?.call(this, event, pos);
        }

        const splitX = geom.drawX + Math.floor(geom.drawW * this.sliderPos);
        this.dragging = true;
        if (Math.hypot(pos[0] - splitX, pos[1] - (geom.drawY + geom.drawH / 2)) >= 15) {
            this.sliderPos = Math.max(0, Math.min(1, x / geom.drawW));
        }
        markDirty(this);
        return true;
    };

    const origOnMouseMove = node.onMouseMove;
    node.onMouseMove = function (event, pos) {
        origOnMouseMove?.call(this, event, pos);
        const geom = getDrawGeom(this);
        const splitX = geom.drawX + Math.floor(geom.drawW * this.sliderPos);
        this.hovered = Math.hypot(pos[0] - splitX, pos[1] - (geom.drawY + geom.drawH / 2)) < 15;

        if (this.dragging) {
            if (event && event.buttons !== undefined && event.buttons === 0) this.dragging = false;
            let nx = (pos[0] - geom.drawX) / geom.drawW;
            nx = Math.max(0, Math.min(1, nx));
            if (Math.abs(nx - this.sliderPos) > 0.001) {
                this.sliderPos = nx;
                markDirty(this);
            }
        }
    };

    const origOnDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx) {
        origOnDrawForeground?.call(this, ctx);
        if (this.flags?.collapsed) return;
        ctx.save();
        drawCompareFrame(this, ctx);
        ctx.restore();
    };

    const origOnExecuted = node.onExecuted;
    node.onExecuted = function (output) {
        origOnExecuted?.call(this, output);
        const srcA = dataUrlFromChunks(output?.b64_a);
        const srcB = dataUrlFromChunks(output?.b64_b);
        if (!srcA || !srcB) return;

        if (this.imgA) this.imgA.onload = this.imgA.onerror = null;
        if (this.imgB) this.imgB.onload = this.imgB.onerror = null;

        this.imgA = new Image();
        this.imgB = new Image();

        this.imgA.onload = () => markDirty(this);
        this.imgB.onload = () => markDirty(this);
        this.imgA.src = srcA;
        this.imgB.src = srcB;
    };
}

function initializeImageCompareNode(node) {
    applyZhLabels(node, ZH_LABEL_MAP);

    if (!node.size || node.size[0] < 100 || node.size[1] < 100) {
        if (typeof node.setSize === "function") node.setSize([...DEFAULT_NODE_SIZE]);
        else node.size = [...DEFAULT_NODE_SIZE];
    } else {
        node.setSize?.([
            Math.max(node.size[0], DEFAULT_NODE_SIZE[0]),
            Math.max(node.size[1], DEFAULT_NODE_SIZE[1]),
        ]);
    }

    const domWidget = createDomWidget(node);
    if (domWidget) {
        installDomOnExecuted(node);
        return;
    }

    installCanvasFallback(node);
}

app.registerExtension({
    name: "ComfyUI_BrotherPao.ImageCompareNode",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "BrotherPao_ImageCompare") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            initializeImageCompareNode(this);
        };
    },
});

(function injectCSS() {
    if (document.getElementById("bp-image-compare-style")) return;

    const style = document.createElement("style");
    style.id = "bp-image-compare-style";
    style.textContent = `
.bp-compare-container {
    width: 100%;
    height: 100%;
    min-height: 220px;
    position: relative;
    border-radius: 4px;
    overflow: hidden;
    background: #111;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.bp-compare-stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #111;
    cursor: ew-resize;
    touch-action: none;
    user-select: none;
}
.bp-compare-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
}
.bp-compare-img-a {
    z-index: 2;
}
.bp-compare-divider {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    z-index: 4;
    transform: translateX(-1px);
    background: #00e0ff;
    box-shadow: 0 0 12px rgba(0, 224, 255, 0.75);
    pointer-events: none;
}
.bp-compare-handle {
    position: absolute;
    top: 50%;
    width: 18px;
    height: 34px;
    z-index: 5;
    transform: translate(-50%, -50%);
    border: 2px solid #00e0ff;
    border-radius: 4px;
    background: rgba(17, 17, 17, 0.72);
    box-shadow: 0 0 12px rgba(0, 224, 255, 0.6);
    pointer-events: none;
}
.bp-compare-handle::before,
.bp-compare-handle::after {
    content: "";
    position: absolute;
    top: 8px;
    bottom: 8px;
    width: 1px;
    background: #00e0ff;
}
.bp-compare-handle::before { left: 6px; }
.bp-compare-handle::after { right: 6px; }
.bp-compare-label,
.bp-compare-size {
    position: absolute;
    z-index: 6;
    color: #fff;
    text-shadow: 0 1px 2px #000, 0 0 4px #000;
    pointer-events: none;
}
.bp-compare-label {
    top: 10px;
    font-size: 14px;
    font-weight: 700;
}
.bp-compare-label-a { left: 10px; }
.bp-compare-label-b { right: 10px; }
.bp-compare-size {
    top: 30px;
    font-size: 10px;
    opacity: 0.85;
}
.bp-compare-size-a { left: 10px; }
.bp-compare-size-b { right: 10px; }
.bp-compare-empty {
    position: absolute;
    inset: 0;
    z-index: 7;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.72);
    font-size: 13px;
    background: #111;
    pointer-events: none;
}
.bp-compare-empty[hidden] {
    display: none;
}
`;
    document.head.appendChild(style);
})();
