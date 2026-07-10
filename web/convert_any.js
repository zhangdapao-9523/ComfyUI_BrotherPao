import { app } from "../../scripts/app.js";

const NODE_ID = "BrotherPao_ConvertAny";
const TYPE_WIDGET = "output_type";
const DEFAULT_TYPE = "STRING";
const OUTPUT_LABELS = new Set(["STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"]);

function chainCallback(object, property, callback) {
    if (!object) return;
    const original = object[property];
    object[property] = function () {
        const result = original?.apply(this, arguments);
        callback.apply(this, arguments);
        return result;
    };
}

function normalizeType(value) {
    const type = String(value || DEFAULT_TYPE).toUpperCase();
    return OUTPUT_LABELS.has(type) ? type : DEFAULT_TYPE;
}

function outputTypeWidget(node) {
    return node.widgets?.find((w) => w.name === TYPE_WIDGET) || null;
}

function readSavedOutputType(node, info = null, includeNodeValues = false) {
    const widget = outputTypeWidget(node);
    const sources = [info?.widgets_values];
    if (includeNodeValues) sources.push(node.widgets_values);

    for (const values of sources) {
        if (Array.isArray(values)) {
            const widgetIndex = node.widgets?.indexOf(widget) ?? -1;
            if (widgetIndex >= 0 && values[widgetIndex] !== undefined) {
                return values[widgetIndex];
            }
            if (values.length === 1) return values[0];
        } else if (values && typeof values === "object" && values[TYPE_WIDGET] !== undefined) {
            return values[TYPE_WIDGET];
        }
    }

    const savedOutput = Array.isArray(info?.outputs) ? info.outputs[0] : null;
    return savedOutput?.type || savedOutput?.name || savedOutput?.label || widget?.value;
}

function syncOutputType(node, forcedType = undefined) {
    const widget = outputTypeWidget(node);
    const output = node.outputs?.[0];
    if (!output) return;

    const type = normalizeType(forcedType ?? widget?.value);
    if (widget && widget.value !== type) {
        widget.value = type;
    }

    const unchanged =
        output.type === type
        && output.name === type
        && output.label === type
        && node._bpConvertAnyOutputType === type;

    output.type = type;
    output.name = type;
    output.label = type;
    node._bpConvertAnyOutputType = type;

    if (!unchanged) {
        node.setDirtyCanvas?.(true, true);
    }
}

function installConvertAnyNode(node) {
    if (node._bpConvertAnyInstalled) return;
    node._bpConvertAnyInstalled = true;

    const widget = outputTypeWidget(node);
    if (widget) {
        widget.label = "输出类型";
        const originalCallback = widget.callback;
        widget.callback = function () {
            node._bpConvertAnyUserChanged = true;
            const result = originalCallback?.apply(this, arguments);
            syncOutputType(node, this?.value ?? widget.value);
            return result;
        };
    }

    chainCallback(node, "onConfigure", function (info) {
        this._bpConvertAnyConfigured = true;
        const savedType = readSavedOutputType(this, info, true);
        syncOutputType(this, savedType);
        setTimeout(() => syncOutputType(this, readSavedOutputType(this, info, true)), 0);
        setTimeout(() => syncOutputType(this, readSavedOutputType(this, info, true)), 100);
    });

    chainCallback(node, "onAdded", function () {
        const includeNodeValues = !this._bpConvertAnyConfigured && !this._bpConvertAnyUserChanged;
        syncOutputType(this, readSavedOutputType(this, null, includeNodeValues));
    });

    chainCallback(node, "onDrawForeground", function () {
        const savedOrCurrentType = readSavedOutputType(this);
        if (normalizeType(savedOrCurrentType) !== this._bpConvertAnyOutputType) {
            syncOutputType(this, savedOrCurrentType);
        }
    });

    syncOutputType(node, readSavedOutputType(node, null, true));
    setTimeout(() => {
        if (!node._bpConvertAnyConfigured && !node._bpConvertAnyUserChanged) {
            syncOutputType(node, readSavedOutputType(node, null, true));
        }
    }, 100);
}

app.registerExtension({
    name: "ComfyUI_BrotherPao.ConvertAny",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        const typeName = nodeData?.name || nodeType?.type || nodeType?.title || nodeType?.name;
        if (typeName !== NODE_ID) return;

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            originalOnNodeCreated?.apply(this, arguments);
            installConvertAnyNode(this);
        };
    },
    nodeCreated(node) {
        if (node.comfyClass !== NODE_ID && node.constructor?.comfyClass !== NODE_ID) return;
        installConvertAnyNode(node);
    },
});
