export const COMMON_ZH_LABELS = {
    "image": "图像",
    "mask": "遮罩",
};

export function findWidgetByName(node, name) {
    return node.widgets ? node.widgets.find((w) => w.name === name) : null;
}

export function toggleWidget(node, widget, show = false) {
    if (!widget) return;
    widget.disabled = !show;
    widget.linkedWidgets?.forEach(w => toggleWidget(node, w, show));
}

export function translateComboWidget(widget, enToZh, zhToEn) {
    if (!widget || !widget.options || !widget.options.values) return;

    widget.options.values = Object.values(enToZh);

    if (widget.value && enToZh[widget.value]) {
        widget.value = enToZh[widget.value];
    }

    widget.serializeValue = async () => {
        const val = widget.value;
        return zhToEn[val] || val;
    };
}

export function applyZhLabels(node, labelMap) {
    for (const w of node.widgets || []) {
        const zhLabel = labelMap[w.name];
        if (zhLabel) {
            w.label = zhLabel;
        }
    }

    for (const inp of node.inputs || []) {
        const zhLabel = labelMap[inp.name];
        if (zhLabel) {
            inp.label = zhLabel;
        }
    }

    for (const o of node.outputs || []) {
        const zhLabel = labelMap[o.name];
        if (zhLabel) {
            o.label = zhLabel;
        }
    }
}
