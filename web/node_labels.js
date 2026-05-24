import { app } from "../../scripts/app.js";
import { translateComboWidget, applyZhLabels, COMMON_ZH_LABELS } from "./shared_utils.js";

const ZH_LABEL_MAP = {
    ...COMMON_ZH_LABELS,
    "reference_image": "参考图像",
    "target_image": "目标图像",
    "method": "匹配方法",
    "images": "图像",
    "text": "文本",
    "translate_to": "翻译为",
    "horizontal_tiles": "水平分块数",
    "vertical_tiles": "垂直分块数",
    "overlap_rate": "重叠率",
    "tile_batch": "分块图像_批次",
    "tile_info": "分块信息",
    "tile_width": "分块宽度",
    "tile_height": "分块高度",
    "blend_width": "融合宽度",
    "overlap_preset": "重叠预设",
    "assembled_image": "拼接图像",
    "info_preview": "信息预览",
    "any_input": "任意输入",
    "boolean": "布尔",
    "revert": "反转输出",
    "yolo_model": "YOLO模型",
    "mask_count": "遮罩数量",
    "select_index": "选择索引",
    "conf": "置信度",
    "iou": "IOU阈值",
    "classes": "类别过滤",
    "device": "推理设备",
    "max_det": "最大检出数",
    "retina_masks": "高分辨率遮罩",
    "agnostic_nms": "类别无关NMS",
    "verbose": "详细输出",
    "annotated_image": "标注图像",
    "bbox_mask": "BBox遮罩",
    "bboxes": "边界框",
    "segs_mask": "Segs遮罩",
    "bbox_mask_list": "BBox遮罩列表",
    "segs_mask_list": "Segs遮罩列表",
    "horizontal_angle": "水平角度",
    "vertical_angle": "垂直角度",
    "zoom": "距离",
    "camera_view": "相机视角",
    "prompt": "提示词",
};

const OVERLAP_PRESET_MAP = {
    "none": "无",
    "1/16 tile": "1/16 分块",
    "1/4 tile": "1/4 分块",
    "1/2 tile": "1/2 分块",
};

const OVERLAP_PRESET_REVERSE_MAP = {};
for (const [en, zh] of Object.entries(OVERLAP_PRESET_MAP)) {
    OVERLAP_PRESET_REVERSE_MAP[zh] = en;
}

const NODE_TYPES = [
    "BrotherPao_ImageColorMatch",
    "BrotherPao_BaiduTrans",
    "BrotherPao_ImageTileBatch",
    "BrotherPao_ImageResolutionDivider",
    "BrotherPao_ImageAssemble",
    "BrotherPao_IsNoInput",
    "BrotherPao_YoloDetect",
    "BrotherPao_QwenMultiangleCamera",
];

app.registerExtension({
    name: "ComfyUI_BrotherPao.NodeLabelTranslation",
    nodeCreated(node) {
        if (NODE_TYPES.indexOf(node.comfyClass) === -1) {
            return;
        }

        applyZhLabels(node, ZH_LABEL_MAP);

        for (const w of node.widgets || []) {
            if (w.name === "overlap_preset") {
                translateComboWidget(w, OVERLAP_PRESET_MAP, OVERLAP_PRESET_REVERSE_MAP);
            }
        }
    }
});
