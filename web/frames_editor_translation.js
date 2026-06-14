import { app } from "../../scripts/app.js";
import { applyZhLabels } from "./shared_utils.js";

const FRAMES_EDITOR_LABELS = {
    "images": "图像帧",
    "info": "标注信息",
    "preview_rescale": "预览缩放",
    "positive_coords": "当前帧正向点",
    "negative_coords": "当前帧负向点",
    "bboxes": "当前帧边界框",
    "frame_index": "当前帧索引",
    "frames_data": "多帧标注数据",
};

function applyFramesEditorLabels(node) {
    applyZhLabels(node, FRAMES_EDITOR_LABELS);

    for (const output of node.outputs || []) {
        const label = FRAMES_EDITOR_LABELS[output.name] || FRAMES_EDITOR_LABELS[output.label] || FRAMES_EDITOR_LABELS[output.localized_name];
        if (!label) {
            continue;
        }
        output.label = label;
        output.localized_name = label;
    }
}

app.registerExtension({
    name: "ComfyUI_BrotherPao.FramesEditorTranslation",
    nodeCreated(node) {
        if (node.comfyClass !== "BrotherPao_FramesEditor") {
            return;
        }

        applyFramesEditorLabels(node);
    },
});
