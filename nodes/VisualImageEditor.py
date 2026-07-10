import json
import logging
import math
import os

import folder_paths
import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image, ImageOps

from comfy_api.latest import io

logger = logging.getLogger(__name__)

DEFAULT_DIVISOR = 16
DIVISOR_MIN = 4
DIVISOR_MAX = 128
DIMENSION_MIN = 64
DIMENSION_MAX = 16384

VISUAL_IMAGE_EDITOR_DESCRIPTION = (
    "导入图像并在节点内可视化裁剪、设置输出分辨率。"
    "输出宽高就是最终 IMAGE 分辨率；蓝色拉框选择源图像区域，输出时缩放到该分辨率。"
)


def _image_files() -> list[str]:
    input_dir = folder_paths.get_input_directory()
    try:
        files = [f for f in os.listdir(input_dir) if os.path.isfile(os.path.join(input_dir, f))]
    except OSError:
        logger.warning("[BrotherPao] Failed to list input images", exc_info=True)
        return []
    return sorted(folder_paths.filter_files_content_types(files, ["image"]))


class VisualImageEditor(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_VisualImageEditor",
            display_name="可视化图像编辑",
            category="❤️‍🩹炮哥Nodes/图像操作",
            description=VISUAL_IMAGE_EDITOR_DESCRIPTION,
            search_aliases=["image editor", "visual image crop", "crop image", "import image"],
            inputs=[
                io.Combo.Input(
                    "file",
                    display_name="图像",
                    options=_image_files(),
                    upload=io.UploadType.image,
                    tooltip="从 ComfyUI input 目录选择或上传图像。",
                ),
                io.Int.Input(
                    "width",
                    display_name="输出宽度",
                    default=512,
                    min=DIMENSION_MIN,
                    max=DIMENSION_MAX,
                    step=DEFAULT_DIVISOR,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="最终输出图像宽度，范围 64-16384；会按分辨率倍率对齐。",
                ),
                io.Int.Input(
                    "height",
                    display_name="输出高度",
                    default=512,
                    min=DIMENSION_MIN,
                    max=DIMENSION_MAX,
                    step=DEFAULT_DIVISOR,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="最终输出图像高度，范围 64-16384；会按分辨率倍率对齐。",
                ),
                io.Int.Input(
                    "divisor",
                    display_name="分辨率倍率",
                    default=DEFAULT_DIVISOR,
                    min=DIVISOR_MIN,
                    max=DIVISOR_MAX,
                    step=1,
                    display_mode=io.NumberDisplay.slider,
                    tooltip="最终输出宽高和拉框宽高都会按该值对齐，范围 4-128，默认 16。",
                ),
                io.String.Input(
                    "state",
                    display_name="编辑状态",
                    optional=True,
                    default="",
                    multiline=False,
                    advanced=True,
                    tooltip="内部状态字段，由前端可视化图像编辑器自动维护，通常不要手动编辑。",
                ),
            ],
            outputs=[
                io.Image.Output("image", display_name="image", tooltip="按拉框裁剪并缩放后的 IMAGE。"),
                io.Mask.Output("mask", display_name="mask", tooltip="按同一区域裁剪并缩放后的 MASK；没有透明通道时为全黑遮罩。"),
                io.String.Output("crop_info", display_name="crop_info", tooltip="实际裁剪和源图像信息 JSON。"),
            ],
        )

    @classmethod
    def execute(cls, file, width=512, height=512, divisor=DEFAULT_DIVISOR, state="") -> io.NodeOutput:
        if not file:
            raise ValueError("请选择或上传一个图像文件。")

        image_path = folder_paths.get_annotated_filepath(file)
        image, mask, source_info = _load_image_and_mask(image_path)
        source_height = int(image.shape[1])
        source_width = int(image.shape[2])

        state_payload = _load_state(state)
        divisor = _clamp_int(divisor or DEFAULT_DIVISOR, DIVISOR_MIN, DIVISOR_MAX)
        output_width, output_height = _resolve_output_size(width, height, source_width, source_height, divisor)
        source_crop = _resolve_source_crop(state_payload, source_width, source_height, output_width, output_height, divisor)

        output_image = _crop_and_resize_image(image, source_crop, output_width, output_height)
        output_mask = _crop_and_resize_mask(mask, source_crop, output_width, output_height)
        crop_info = {
            "source": {
                "file": file,
                "width": source_width,
                "height": source_height,
                "mode": source_info["mode"],
                "has_alpha": source_info["has_alpha"],
            },
            "output": {
                "width": output_width,
                "height": output_height,
                "divisor": divisor,
            },
            "crop": source_crop,
        }
        return io.NodeOutput(output_image, output_mask, json.dumps(crop_info, ensure_ascii=False))

    @classmethod
    def validate_inputs(cls, file, **kwargs):
        if not file:
            return "请选择或上传一个图像文件。"
        if not folder_paths.exists_annotated_filepath(file):
            return f"图像文件不存在: {file}"
        return True

    @classmethod
    def fingerprint_inputs(cls, file, width=512, height=512, divisor=DEFAULT_DIVISOR, state=""):
        image_path = folder_paths.get_annotated_filepath(file)
        try:
            mod_time = os.path.getmtime(image_path)
        except OSError:
            mod_time = 0
        return (file, mod_time, width, height, divisor, state)


def _load_state(state: str) -> dict:
    if not state:
        return {}
    try:
        payload = json.loads(state)
    except json.JSONDecodeError:
        logger.warning("[BrotherPao] VisualImageEditor state JSON parse failed", exc_info=True)
        return {}
    return payload if isinstance(payload, dict) else {}


def _has_alpha(image: Image.Image) -> bool:
    return "A" in image.getbands() or "transparency" in image.info


def _load_image_and_mask(image_path: str) -> tuple[torch.Tensor, torch.Tensor, dict]:
    with Image.open(image_path) as raw:
        try:
            raw.seek(0)
        except EOFError:
            pass
        image = ImageOps.exif_transpose(raw)
        mode = image.mode
        has_alpha = _has_alpha(image)

        if has_alpha:
            rgba = image.convert("RGBA")
            rgb = rgba.convert("RGB")
            alpha = np.array(rgba.getchannel("A")).astype(np.float32) / 255.0
            mask_array = 1.0 - alpha
        else:
            rgb = image.convert("RGB")
            mask_array = np.zeros((rgb.height, rgb.width), dtype=np.float32)

        image_array = np.array(rgb).astype(np.float32) / 255.0

    image_tensor = torch.from_numpy(np.ascontiguousarray(image_array)).unsqueeze(0)
    mask_tensor = torch.from_numpy(np.ascontiguousarray(mask_array)).unsqueeze(0)
    return image_tensor, mask_tensor, {"mode": mode, "has_alpha": has_alpha}


def _positive_int(value) -> int | None:
    try:
        result = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return result if result > 0 else None


def _clamp_float(value, minimum: float, maximum: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        result = minimum
    if not math.isfinite(result):
        result = minimum
    return max(minimum, min(maximum, result))


def _clamp_int(value, minimum: int, maximum: int) -> int:
    return int(round(_clamp_float(value, minimum, maximum)))


def _align_dimension(value, divisor: int) -> int:
    try:
        raw = int(round(float(value)))
    except (TypeError, ValueError):
        raw = 1
    if divisor <= 1:
        return max(1, raw)
    rounded = int(round(raw / divisor) * divisor)
    return max(divisor, rounded)


def _align_output_dimension(value, divisor: int) -> int:
    return _clamp_int(_align_dimension(value, divisor), DIMENSION_MIN, DIMENSION_MAX)


def _align_down_dimension(value, divisor: int) -> int:
    try:
        raw = int(math.floor(float(value)))
    except (TypeError, ValueError):
        raw = 1
    if divisor <= 1:
        return max(1, raw)
    return max(1, int(math.floor(raw / divisor) * divisor))


def _resolve_output_size(width, height, source_width: int, source_height: int, divisor: int) -> tuple[int, int]:
    width_value = _positive_int(width) or source_width
    height_value = _positive_int(height) or source_height
    return _align_output_dimension(width_value, divisor), _align_output_dimension(height_value, divisor)


def _read_crop(raw_crop) -> dict | None:
    if not isinstance(raw_crop, dict):
        return None
    try:
        return {
            "x": float(raw_crop.get("x", 0.0) or 0.0),
            "y": float(raw_crop.get("y", 0.0) or 0.0),
            "w": float(raw_crop.get("w", 0.0) or 0.0),
            "h": float(raw_crop.get("h", 0.0) or 0.0),
        }
    except (TypeError, ValueError):
        return None


def _fit_crop_size(output_width: int, output_height: int, desired_w: float, desired_h: float, max_w: int, max_h: int, divisor: int) -> tuple[int, int]:
    ratio = max(0.001, float(output_width) / max(1, float(output_height)))
    limit_w = max(1, int(max_w))
    limit_h = max(1, int(max_h))
    raw_w = max(1.0, float(desired_w or 1.0))
    raw_h = max(1.0, float(desired_h or 1.0))
    use_width = raw_w / raw_h >= ratio
    crop_w = _align_dimension(raw_w if use_width else raw_h * ratio, divisor)
    crop_h = _align_dimension(crop_w / ratio, divisor)

    if crop_w > limit_w or crop_h > limit_h:
        crop_w = _align_down_dimension(min(limit_w, limit_h * ratio), divisor)
        crop_h = _align_down_dimension(crop_w / ratio, divisor)
        while (crop_w > limit_w or crop_h > limit_h) and crop_w > 1:
            crop_w = _align_down_dimension(crop_w - 1, divisor)
            crop_h = _align_down_dimension(crop_w / ratio, divisor)

    return max(1, min(limit_w, int(crop_w))), max(1, min(limit_h, int(crop_h)))


def _normalize_source_crop(crop: dict, source_width: int, source_height: int, output_width: int, output_height: int, divisor: int) -> dict:
    x = max(0, min(source_width - 1, int(round(float(crop["x"])))))
    y = max(0, min(source_height - 1, int(round(float(crop["y"])))))
    crop_w, crop_h = _fit_crop_size(
        output_width,
        output_height,
        max(1.0, float(crop["w"])),
        max(1.0, float(crop["h"])),
        source_width - x,
        source_height - y,
        divisor,
    )

    return {
        "x": x,
        "y": y,
        "w": crop_w,
        "h": crop_h,
    }


def _default_source_crop(source_width: int, source_height: int, output_width: int, output_height: int, divisor: int) -> dict:
    crop_w, crop_h = _fit_crop_size(output_width, output_height, source_width, source_height, source_width, source_height, divisor)
    crop = {
        "x": (source_width - crop_w) / 2,
        "y": (source_height - crop_h) / 2,
        "w": crop_w,
        "h": crop_h,
    }
    return _normalize_source_crop(crop, source_width, source_height, output_width, output_height, divisor)


def _resolve_source_crop(payload: dict, source_width: int, source_height: int, output_width: int, output_height: int, divisor: int) -> dict:
    crop = _read_crop(payload.get("crop") if isinstance(payload.get("crop"), dict) else None)
    if crop is None:
        return _default_source_crop(source_width, source_height, output_width, output_height, divisor)
    return _normalize_source_crop(crop, source_width, source_height, output_width, output_height, divisor)


def _crop_bounds(crop: dict, source_width: int, source_height: int) -> tuple[int, int, int, int]:
    x = max(0, min(source_width - 1, int(crop["x"])))
    y = max(0, min(source_height - 1, int(crop["y"])))
    w = max(1, min(source_width - x, int(crop["w"])))
    h = max(1, min(source_height - y, int(crop["h"])))
    return x, y, w, h


def _crop_and_resize_image(image: torch.Tensor, crop: dict, target_width: int, target_height: int) -> torch.Tensor:
    source_height = int(image.shape[1])
    source_width = int(image.shape[2])
    x, y, w, h = _crop_bounds(crop, source_width, source_height)
    cropped = image[:, y:y + h, x:x + w, :]
    resized = F.interpolate(
        cropped.movedim(-1, 1),
        size=(target_height, target_width),
        mode="bilinear",
        align_corners=False,
    ).movedim(1, -1)
    return resized.clamp(0.0, 1.0).contiguous()


def _crop_and_resize_mask(mask: torch.Tensor, crop: dict, target_width: int, target_height: int) -> torch.Tensor:
    source_height = int(mask.shape[1])
    source_width = int(mask.shape[2])
    x, y, w, h = _crop_bounds(crop, source_width, source_height)
    cropped = mask[:, y:y + h, x:x + w].unsqueeze(1)
    resized = F.interpolate(
        cropped,
        size=(target_height, target_width),
        mode="bilinear",
        align_corners=False,
    ).squeeze(1)
    return resized.clamp(0.0, 1.0).contiguous()
