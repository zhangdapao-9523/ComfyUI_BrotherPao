import { app } from "../../scripts/app.js";
import { translateComboWidget, applyZhLabels } from "./shared_utils.js";

const ZH_LABEL_MAP = {
    "image": "图像",
    "mask": "遮罩",
    "optional_context_mask": "上下文遮罩",
    "downscale_algorithm": "缩小算法",
    "upscale_algorithm": "放大算法",
    "mask_fill_holes": "填充遮罩空洞",
    "mask_expand_pixels": "遮罩扩展像素",
    "mask_invert": "反转遮罩",
    "mask_blend_pixels": "混合过渡像素",
    "mask_hipass_filter": "遮罩高通过滤",
    "context_from_mask_extend_factor": "上下文扩展倍数",
    "output_resize_to_target_size": "缩放到目标尺寸",
    "output_target_width": "目标宽度",
    "output_target_height": "目标高度",
    "output_padding": "输出对齐倍数",
    "device_mode": "计算设备",
    "stitcher": "缝合数据",
    "inpainted_image": "内补图像",
    "cropped_image": "裁剪图像",
    "cropped_mask": "裁剪遮罩",
};

const DEVICE_MODE_MAP = {
    "cpu": "cpu（兼容模式）",
    "gpu": "gpu（快速模式）",
};

const DEVICE_MODE_REVERSE_MAP = {};
for (const [en, zh] of Object.entries(DEVICE_MODE_MAP)) {
    DEVICE_MODE_REVERSE_MAP[zh] = en;
}

function inpaintCropAndStitchHandler(node) {
    if (node.comfyClass == "BrotherPao_InpaintCropImproved") {
        toggleWidget(node, findWidgetByName(node, "output_target_width"));
        toggleWidget(node, findWidgetByName(node, "output_target_height"));
        if (findWidgetByName(node, "output_resize_to_target_size").value == true) {
            toggleWidget(node, findWidgetByName(node, "output_target_width"), true);
            toggleWidget(node, findWidgetByName(node, "output_target_height"), true);
        }
    }
    return;
}

const findWidgetByName = (node, name) => {
    return node.widgets ? node.widgets.find((w) => w.name === name) : null;
};

function toggleWidget(node, widget, show = false, suffix = "") {
    if (!widget) return;
    widget.disabled = !show;
    widget.linkedWidgets?.forEach(w => toggleWidget(node, w, show, ":" + widget.name));
}

app.registerExtension({
    name: "inpaint-cropandstitch.showcontrol",
    nodeCreated(node) {
        if (!node.comfyClass.startsWith("BrotherPao_Inpaint")) {
            return;
        }

        applyZhLabels(node, ZH_LABEL_MAP);

        for (const w of node.widgets || []) {
            if (w.name === "device_mode") {
                translateComboWidget(w, DEVICE_MODE_MAP, DEVICE_MODE_REVERSE_MAP);
            }
        }

        inpaintCropAndStitchHandler(node);
        for (const w of node.widgets || []) {
            let widgetValue = w.value;

            let originalDescriptor = Object.getOwnPropertyDescriptor(w, 'value') ||
                Object.getOwnPropertyDescriptor(Object.getPrototypeOf(w), 'value');
            if (!originalDescriptor) {
                originalDescriptor = Object.getOwnPropertyDescriptor(w.constructor.prototype, 'value');
            }

            try {
                Object.defineProperty(w, 'value', {
                    get() {
                        let valueToReturn = originalDescriptor && originalDescriptor.get
                            ? originalDescriptor.get.call(w)
                            : widgetValue;

                        return valueToReturn;
                    },
                    set(newVal) {
                        if (originalDescriptor && originalDescriptor.set) {
                            originalDescriptor.set.call(w, newVal);
                        } else {
                            widgetValue = newVal;
                        }

                        try {
                            inpaintCropAndStitchHandler(node);
                        } catch (handlerErr) {
                            console.error("[BrotherPao] inpaintCropAndStitchHandler error:", handlerErr);
                        }
                    }
                });
            } catch (defineErr) {
                console.error("[BrotherPao] Failed to define property for widget:", w.name, defineErr);
            }
        }
    }
});
