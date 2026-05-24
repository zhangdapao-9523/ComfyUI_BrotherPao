import logging
import os
from typing import Dict, List, Optional

import numpy as np
import torch
from PIL import Image, ImageDraw

import folder_paths
from .utils import pil2tensor, tensor2pil

logger = logging.getLogger(__name__)

YOLO_MODELS_DIR = os.path.join(folder_paths.models_dir, "ultralytics")
os.makedirs(YOLO_MODELS_DIR, exist_ok=True)
folder_paths.add_model_folder_path("ultralytics", YOLO_MODELS_DIR, is_default=True)

DEVICE_CHOICES = ("auto", "cuda", "cpu", "mps")
MASK_COUNT_CHOICES = ("all", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10")
MASK_INDEX_CHOICES = ("none", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10")

COCO80_TOOLTIP = (
    "类别 ID 过滤，逗号分隔或范围。留空保留所有类别。\n"
    "0:person(人)  1:bicycle(自行车)  2:car(汽车)  3:motorcycle(摩托车)\n"
    "4:airplane(飞机)  5:bus(公交车)  6:train(火车)  7:truck(卡车)\n"
    "8:boat(船)  9:traffic light(红绿灯)  10:fire hydrant(消防栓)  11:stop sign(停止标志)\n"
    "12:parking meter(停车计时器)  13:bench(长椅)  14:bird(鸟)  15:cat(猫)\n"
    "16:dog(狗)  17:horse(马)  18:sheep(羊)  19:cow(牛)\n"
    "20:elephant(大象)  21:bear(熊)  22:zebra(斑马)  23:giraffe(长颈鹿)\n"
    "24:backpack(背包)  25:umbrella(雨伞)  26:handbag(手提包)  27:tie(领带)\n"
    "28:suitcase(行李箱)  29:frisbee(飞盘)  30:skis(滑雪板)  31:snowboard(单板)\n"
    "32:sports ball(球)  33:kite(风筝)  34:baseball bat(棒球棒)  35:baseball glove(棒球手套)\n"
    "36:skateboard(滑板)  37:surfboard(冲浪板)  38:tennis racket(网球拍)  39:bottle(瓶子)\n"
    "40:wine glass(酒杯)  41:cup(杯子)  42:fork(叉子)  43:knife(刀)\n"
    "44:spoon(勺子)  45:bowl(碗)  46:banana(香蕉)  47:apple(苹果)\n"
    "48:sandwich(三明治)  49:orange(橙子)  50:broccoli(西兰花)  51:carrot(胡萝卜)\n"
    "52:hot dog(热狗)  53:pizza(披萨)  54:donut(甜甜圈)  55:cake(蛋糕)\n"
    "56:chair(椅子)  57:couch(沙发)  58:potted plant(盆栽)  59:bed(床)\n"
    "60:dining table(餐桌)  61:toilet(马桶)  62:tv(电视)  63:laptop(笔记本)\n"
    "64:mouse(鼠标)  65:remote(遥控器)  66:keyboard(键盘)  67:cell phone(手机)\n"
    "68:microwave(微波炉)  69:oven(烤箱)  70:toaster(烤面包机)  71:sink(水槽)\n"
    "72:refrigerator(冰箱)  73:book(书)  74:clock(时钟)  75:vase(花瓶)\n"
    "76:scissors(剪刀)  77:teddy bear(泰迪熊)  78:hair drier(吹风机)  79:toothbrush(牙刷)"
)


class YoloDetect:
    CATEGORY = "❤️‍🩹炮哥Nodes/实用工具"
    RETURN_TYPES = ("IMAGE", "BBOXES", "MASK", "MASK", "MASK", "MASK")
    RETURN_NAMES = ("annotated_image", "bboxes", "bbox_mask", "segs_mask", "bbox_mask_list", "segs_mask_list")
    FUNCTION = "run_detection"

    _MODEL_CACHE: Dict[str, object] = {}
    _HAS_SEG_CACHE: Dict[str, bool] = {}

    @classmethod
    def _scan_models(cls) -> List[str]:
        files = folder_paths.get_filename_list("ultralytics")
        return sorted(f for f in files if f.lower().endswith(".pt"))

    @classmethod
    def INPUT_TYPES(cls):
        models = cls._scan_models()
        if not models:
            models = [f"将 .pt 模型文件放入 {YOLO_MODELS_DIR}"]
        default_model = models[0]

        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "输入图像"}),
                "yolo_model": (tuple(models), {"default": default_model, "tooltip": f"YOLOv8 权重文件，存放于 {YOLO_MODELS_DIR}"}),
                "mask_count": (MASK_COUNT_CHOICES, {"default": "all", "tooltip": "合并前 N 个检出的掩码。'all' 为合并全部检出"}),
            },
            "optional": {
                "select_index": (MASK_INDEX_CHOICES, {"default": "none", "tooltip": "从第几个检出开始选取（1-based）。'none' 从第一个开始，影响所有边界框和遮罩输出"}),
                "conf": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "置信度阈值"}),
                "iou": ("FLOAT", {"default": 0.45, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "NMS 的 IOU 阈值"}),
                "classes": ("STRING", {"default": "", "placeholder": "例: 0,2,5-7", "tooltip": COCO80_TOOLTIP}),
                "device": (DEVICE_CHOICES, {"default": "auto", "tooltip": "推理设备，auto 自动检测 CUDA → MPS → CPU"}),
                "max_det": ("INT", {"default": 300, "min": 1, "max": 1000, "step": 1, "tooltip": "每张图像最大检出数"}),
                "retina_masks": ("BOOLEAN", {"default": True, "tooltip": "使用高分辨率掩码"}),
                "agnostic_nms": ("BOOLEAN", {"default": False, "tooltip": "启用类别无关 NMS"}),
                "verbose": ("BOOLEAN", {"default": False, "tooltip": "推理过程中输出详细信息"}),
            },
        }

    def _pick_device(self, requested: str) -> str:
        if requested != "auto":
            return requested
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def _decode_class_filter(self, value: str) -> Optional[List[int]]:
        if not value or not value.strip():
            return None
        classes: List[int] = []
        try:
            for chunk in value.split(","):
                chunk = chunk.strip()
                if not chunk:
                    continue
                if "-" in chunk:
                    start, end = [int(x) for x in chunk.split("-", 1)]
                    if start > end:
                        start, end = end, start
                    classes.extend(range(start, end + 1))
                else:
                    classes.append(int(chunk))
            return sorted(set(classes))
        except ValueError:
            logger.warning("Invalid classes string: %s. Ignoring filter.", value)
            return None

    def _find_model_path(self, name: str) -> str:
        return folder_paths.get_full_path_or_raise("ultralytics", name)

    def _load_model(self, model_path: str):
        model = self._MODEL_CACHE.get(model_path)
        if model is None:
            from ultralytics import YOLO
            model = YOLO(model_path)
            self._MODEL_CACHE[model_path] = model
        return model

    def _annotated_to_tensor(self, result) -> torch.Tensor:
        plotted = result.plot()
        rgb = plotted[..., ::-1]
        return pil2tensor(Image.fromarray(rgb))

    def _tensor_to_mask_image(self, mask_tensor: torch.Tensor, size, max_size: int = None):
        mask_np = mask_tensor.detach().cpu().numpy()
        mask_img = Image.fromarray((mask_np * 255).astype(np.uint8))
        if mask_img.size != size:
            if max_size is not None:
                scale = min(max_size / max(size), 1.0)
                size = (int(size[0] * scale), int(size[1] * scale))
            mask_img = mask_img.resize(size, Image.Resampling.NEAREST)
        return pil2tensor(mask_img, unsqueeze=False)

    def _model_has_seg(self, model_path: str) -> bool:
        if model_path in self._HAS_SEG_CACHE:
            return self._HAS_SEG_CACHE[model_path]
        try:
            model = self._load_model(model_path)
            has_seg = model.model.model[-1].__class__.__name__.lower().find("segment") != -1
        except Exception:
            has_seg = False
        self._HAS_SEG_CACHE[model_path] = has_seg
        return has_seg

    def _standardize_bbox(self, bboxes: list) -> list:
        ret = []
        for bbox in bboxes:
            x1 = int(min(bbox[0], bbox[2]))
            y1 = int(min(bbox[1], bbox[3]))
            x2 = int(max(bbox[0], bbox[2]))
            y2 = int(max(bbox[1], bbox[3]))
            ret.append([x1, y1, x2, y2])
        return ret

    def _extract_bboxes(self, result) -> List[List[int]]:
        bboxes: List[List[int]] = []
        if getattr(result, "boxes", None) is not None and len(result.boxes.xyxy) > 0:
            for box in result.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                bboxes.append([x1, y1, x2, y2])
        return self._standardize_bbox(bboxes)

    def _extract_bbox_masks(self, result, size) -> List[torch.Tensor]:
        width, height = size
        masks: List[torch.Tensor] = []

        if getattr(result, "boxes", None) is not None and len(result.boxes.xyxy) > 0:
            for box in result.boxes:
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                mask_img = Image.new("L", size, 0)
                draw = ImageDraw.Draw(mask_img)
                draw.rectangle([x1, y1, x2, y2], fill=255)
                masks.append(pil2tensor(mask_img, unsqueeze=False))

        if not masks:
            masks.append(torch.zeros((height, width), dtype=torch.float32))

        return masks

    def _extract_segs_masks(self, result, size) -> List[torch.Tensor]:
        width, height = size

        if getattr(result, "masks", None) is not None and result.masks.data is not None:
            masks = [self._tensor_to_mask_image(m, size) for m in result.masks.data]
        else:
            masks = self._extract_bbox_masks(result, size)

        if not masks:
            masks.append(torch.zeros((height, width), dtype=torch.float32))

        return masks

    def _combine_masks(self, masks: List[torch.Tensor]) -> torch.Tensor:
        if not masks:
            return torch.zeros((1, 1), dtype=torch.float32)
        merged = torch.zeros_like(masks[0])
        for mask in masks:
            merged = torch.maximum(merged, mask)
        return merged

    def run_detection(
        self,
        images,
        yolo_model,
        mask_count="all",
        conf=0.25,
        iou=0.45,
        classes="",
        device="auto",
        max_det=300,
        retina_masks=True,
        agnostic_nms=False,
        select_index="none",
        verbose=False,
    ):
        model_path = self._find_model_path(yolo_model)
        model = self._load_model(model_path)
        device_target = self._pick_device(device)
        class_filter = self._decode_class_filter(classes)

        bbox_merged: List[torch.Tensor] = []
        segs_merged: List[torch.Tensor] = []
        annotated_images: List[torch.Tensor] = []
        bboxes_batch: List[List[List[int]]] = []
        bbox_mask_list: List[torch.Tensor] = []
        segs_mask_list: List[torch.Tensor] = []

        count_limit = 0 if mask_count == "all" else max(0, int(mask_count))
        chosen_index: Optional[int] = None
        if select_index != "none":
            chosen_index = int(select_index) - 1

        for idx in range(images.shape[0]):
            image_pil = tensor2pil(images[idx])

            results = model(
                image_pil,
                conf=conf,
                iou=iou,
                classes=class_filter,
                device=device_target,
                max_det=max_det,
                retina_masks=retina_masks,
                agnostic_nms=agnostic_nms,
                verbose=verbose,
            )

            if not results:
                continue

            result = results[0]
            annotated_images.append(self._annotated_to_tensor(result))

            frame_bboxes = self._extract_bboxes(result)
            if chosen_index is None:
                limit = count_limit if count_limit > 0 else len(frame_bboxes)
                selected_frame_bboxes = frame_bboxes[:min(limit, len(frame_bboxes))]
            else:
                if chosen_index >= len(frame_bboxes):
                    selected_frame_bboxes = []
                else:
                    span = count_limit if count_limit > 0 else 1
                    selected_frame_bboxes = frame_bboxes[chosen_index:chosen_index + span]
            bboxes_batch.append(selected_frame_bboxes)

            bbox_frame_masks = self._extract_bbox_masks(result, image_pil.size)
            segs_frame_masks = self._extract_segs_masks(result, image_pil.size)

            selected_bbox: List[torch.Tensor]
            selected_segs: List[torch.Tensor]
            if chosen_index is None:
                limit = count_limit if count_limit > 0 else len(bbox_frame_masks)
                selected_bbox = bbox_frame_masks[:min(limit, len(bbox_frame_masks))]
                selected_segs = segs_frame_masks[:min(limit, len(segs_frame_masks))]
            else:
                if chosen_index >= len(bbox_frame_masks):
                    selected_bbox = []
                else:
                    span = count_limit if count_limit > 0 else 1
                    selected_bbox = bbox_frame_masks[chosen_index:chosen_index + span]
                if chosen_index >= len(segs_frame_masks):
                    selected_segs = []
                else:
                    span = count_limit if count_limit > 0 else 1
                    selected_segs = segs_frame_masks[chosen_index:chosen_index + span]

            if selected_bbox:
                bbox_merged.append(self._combine_masks(selected_bbox))
                bbox_mask_list.extend(selected_bbox)
            else:
                fallback = torch.zeros_like(bbox_frame_masks[0])
                bbox_merged.append(fallback)
                bbox_mask_list.append(fallback)

            if selected_segs:
                segs_merged.append(self._combine_masks(selected_segs))
            else:
                fallback = torch.zeros_like(segs_frame_masks[0])
                segs_merged.append(fallback)

            segs_mask_list.extend(selected_segs if selected_segs else [torch.zeros_like(segs_frame_masks[0])])

        fallback_size = tensor2pil(images[0]).size
        fh, fw = fallback_size[1], fallback_size[0]

        if not bbox_merged:
            bbox_merged = [torch.zeros((fh, fw), dtype=torch.float32)]
        if not segs_merged:
            segs_merged = [torch.zeros((fh, fw), dtype=torch.float32)]
        if not bboxes_batch:
            bboxes_batch = [[]]
        if not bbox_mask_list:
            bbox_mask_list = [torch.zeros((fh, fw), dtype=torch.float32)]
        if not segs_mask_list:
            segs_mask_list = [torch.zeros((fh, fw), dtype=torch.float32)]
        if not annotated_images:
            annotated_images = [images]

        annotated_tensor = torch.cat(annotated_images, dim=0)
        bbox_tensor = torch.stack(bbox_merged, dim=0)
        segs_tensor = torch.stack(segs_merged, dim=0)
        bbox_list_tensor = torch.stack(bbox_mask_list, dim=0)
        segs_list_tensor = torch.stack(segs_mask_list, dim=0)

        return annotated_tensor, bboxes_batch, bbox_tensor, segs_tensor, bbox_list_tensor, segs_list_tensor


NODE_CLASS_MAPPINGS = {
    "BrotherPao_YoloDetect": YoloDetect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BrotherPao_YoloDetect": "YOLO-V8目标检测",
}
