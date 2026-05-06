import numpy as np
import math
import torch
from PIL import Image


def pil2tensor(image: Image) -> torch.Tensor:
    return torch.from_numpy(np.array(image).astype(np.float32) / 255.0).unsqueeze(0)


def tensor2pil(t_image: torch.Tensor) -> Image:
    return Image.fromarray(np.clip(255.0 * t_image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8))


def make_tile_info(positions, original_size, grid_size, tile_size):
    return {
        "positions": positions,
        "original_size": original_size,
        "grid_size": grid_size,
        "tile_size": tile_size,
        "class": "TILE_INFO"
    }


def unpack_tile_info(tile_info):
    positions = tile_info["positions"]
    original_size = tile_info["original_size"]
    grid_size = tile_info["grid_size"]
    tile_size = tile_info.get("tile_size", None)
    return positions, original_size, grid_size, tile_size


SCALING_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]

IMAGE_TILE_NODE_DESC = """将图像按行列分块数裁剪为带重叠的图像批次。自动计算分块尺寸并对齐到 8 的倍数。拼接节点会根据实际分块尺寸自动适配缩放。"""


class ImageTileBatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {
                    "tooltip": "输入图像。"
                }),
                "水平分块数": ("INT", {
                    "default": 3, "min": 1, "max": 10, "step": 1,
                    "tooltip": "水平分块列数，值越大分块越窄。"
                }),
                "垂直分块数": ("INT", {
                    "default": 3, "min": 1, "max": 10, "step": 1,
                    "tooltip": "垂直分块行数，值越大分块越矮。"
                }),
                "重叠率": ("FLOAT", {
                    "default": 0.1, "min": 0.00, "max": 0.95, "step": 0.05,
                    "tooltip": "相邻分块的重叠比例。0=无重叠；0.1=约10%重叠。越大接缝越不明显，推荐 0.05~0.2。"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "TILE_INFO", "INT", "INT")
    RETURN_NAMES = ("分块图像_批次", "分块信息", "分块宽度", "分块高度")
    FUNCTION = "tile_image"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像操作"
    DESCRIPTION = IMAGE_TILE_NODE_DESC

    def _calculate_tile_size(self, raw_W, raw_H, width_factor, height_factor, overlap_rate):
        if overlap_rate == 0:
            if width_factor == 1:
                tile_width = raw_W
            else:
                tile_width = int(raw_W / width_factor)
                if tile_width % 8 != 0:
                    tile_width = ((tile_width + 7) // 8) * 8
            if height_factor == 1:
                tile_height = raw_H
            else:
                tile_height = int(raw_H / height_factor)
                if tile_height % 8 != 0:
                    tile_height = ((tile_height + 7) // 8) * 8
        else:
            if width_factor == 1:
                tile_width = raw_W
            else:
                tile_width = int(raw_W / (1 + (width_factor - 1) * (1 - overlap_rate)))
                if tile_width % 8 != 0:
                    tile_width = (tile_width // 8) * 8
            if height_factor == 1:
                tile_height = raw_H
            else:
                tile_height = int(raw_H / (1 + (height_factor - 1) * (1 - overlap_rate)))
                if tile_height % 8 != 0:
                    tile_height = (tile_height // 8) * 8
        return tile_width, tile_height

    def _calculate_step(self, size, tile_size):
        if size <= tile_size:
            return 1, 0
        num_tiles = (size + tile_size - 1) // tile_size
        overlap = (num_tiles * tile_size - size) // (num_tiles - 1)
        step = tile_size - overlap
        return num_tiles, step

    def tile_image(self, 图像, 水平分块数, 垂直分块数, 重叠率):
        _, raw_H, raw_W, _ = 图像.shape

        tile_width, tile_height = self._calculate_tile_size(
            raw_W, raw_H, 水平分块数, 垂直分块数, 重叠率
        )

        image = tensor2pil(图像.squeeze(0))
        img_width, img_height = image.size

        num_cols, step_x = self._calculate_step(img_width, tile_width)
        num_rows, step_y = self._calculate_step(img_height, tile_height)

        tiles = []
        positions = []
        for y in range(num_rows):
            for x in range(num_cols):
                left = x * step_x
                upper = y * step_y
                right = min(left + tile_width, img_width)
                lower = min(upper + tile_height, img_height)
                if right - left < tile_width:
                    left = max(0, img_width - tile_width)
                if lower - upper < tile_height:
                    upper = max(0, img_height - tile_height)
                tile = image.crop((left, upper, right, lower))
                tile_tensor = pil2tensor(tile)
                tiles.append(tile_tensor)
                positions.append((left, upper, right, lower))

        tiles = torch.stack(tiles, dim=0).squeeze(1)
        tile_info = make_tile_info(positions, (img_width, img_height), (num_cols, num_rows), (tile_width, tile_height))
        return (tiles, tile_info, tile_width, tile_height)


IMAGE_ASSEMBLE_DESC = """将分块图像拼接回完整图像。自动对比原始分块尺寸与实际分块尺寸推导缩放倍率，支持渐变融合消除接缝。"""


class ImageAssemble:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "分块图像_批次": ("IMAGE", {
                    "tooltip": "分块图像批次，来自「图像分块 批处理」。"
                }),
                "分块信息": ("TILE_INFO", {
                    "tooltip": "分块信息结构体，来自「图像分块 批处理」。节点自动根据实际分块尺寸推导缩放倍率。"
                }),
                "融合宽度": ("INT", {
                    "default": 64, "min": 0,
                    "tooltip": "渐变融合的像素宽度。0=不融合直接拼接；值越大过渡越平滑。会根据缩放倍率等比调整，推荐 32~128。"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("拼接图像",)
    FUNCTION = "assemble_image"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像操作"
    DESCRIPTION = IMAGE_ASSEMBLE_DESC

    def _create_gradient_mask(self, size, direction):
        mask = Image.new("L", size)
        if direction == 'horizontal':
            for i in range(size[0]):
                value = int(255 * (1 - i / size[0]))
                mask.paste(value, (i, 0, i + 1, size[1]))
        else:
            for i in range(size[1]):
                value = int(255 * (1 - i / size[1]))
                mask.paste(value, (0, i, size[0], i + 1))
        return mask

    def _blend_tiles(self, tile1, tile2, overlap_size, direction, padding):
        blend_size = padding
        if blend_size > overlap_size:
            blend_size = overlap_size
        if blend_size == 0:
            if direction == 'horizontal':
                result = Image.new("RGB", (tile1.width + tile2.width - overlap_size, tile1.height))
                result.paste(tile1.crop((0, 0, tile1.width - overlap_size, tile1.height)), (0, 0))
                result.paste(tile2, (tile1.width - overlap_size, 0))
            else:
                result = Image.new("RGB", (tile1.width, tile1.height + tile2.height - overlap_size))
                result.paste(tile1.crop((0, 0, tile1.width, tile1.height - overlap_size)), (0, 0))
                result.paste(tile2, (0, tile1.height - overlap_size))
            return result

        offset_total = overlap_size - blend_size
        offset_left = offset_total // 2
        offset_right = offset_total - offset_left

        size = (blend_size, tile1.height) if direction == 'horizontal' else (tile1.width, blend_size)
        mask = self._create_gradient_mask(size, direction)

        if direction == 'horizontal':
            crop_tile1 = tile1.crop((tile1.width - overlap_size + offset_left, 0, tile1.width - offset_right, tile1.height))
            crop_tile2 = tile2.crop((offset_left, 0, offset_left + blend_size, tile2.height))
            if crop_tile1.size != crop_tile2.size:
                raise ValueError(f"Crop sizes do not match: {crop_tile1.size} vs {crop_tile2.size}")
            blended = Image.composite(crop_tile1, crop_tile2, mask)
            result = Image.new("RGB", (tile1.width + tile2.width - overlap_size, tile1.height))
            result.paste(tile1.crop((0, 0, tile1.width - overlap_size + offset_left, tile1.height)), (0, 0))
            result.paste(blended, (tile1.width - overlap_size + offset_left, 0))
            result.paste(tile2.crop((offset_left + blend_size, 0, tile2.width, tile2.height)), (tile1.width - offset_right, 0))
        else:
            offset_top = offset_total // 2
            offset_bottom = offset_total - offset_top
            size = (tile1.width, blend_size)
            mask = self._create_gradient_mask(size, direction)
            crop_tile1 = tile1.crop((0, tile1.height - overlap_size + offset_top, tile1.width, tile1.height - offset_bottom))
            crop_tile2 = tile2.crop((0, offset_top, tile2.width, offset_top + blend_size))
            if crop_tile1.size != crop_tile2.size:
                raise ValueError(f"Crop sizes do not match: {crop_tile1.size} vs {crop_tile2.size}")
            blended = Image.composite(crop_tile1, crop_tile2, mask)
            result = Image.new("RGB", (tile1.width, tile1.height + tile2.height - overlap_size))
            result.paste(tile1.crop((0, 0, tile1.width, tile1.height - overlap_size + offset_top)), (0, 0))
            result.paste(blended, (0, tile1.height - overlap_size + offset_top))
            result.paste(tile2.crop((0, offset_top + blend_size, tile2.width, tile2.height)), (0, tile1.height - offset_bottom))
        return result

    def assemble_image(self, 分块图像_批次, 分块信息, 融合宽度):
        分块位置, 原始尺寸, 网格尺寸, 原始分块尺寸 = unpack_tile_info(分块信息)
        num_cols, num_rows = 网格尺寸

        first_tile = tensor2pil(分块图像_批次[0].unsqueeze(0))
        actual_tile_w, actual_tile_h = first_tile.size

        if 原始分块尺寸 is not None:
            orig_tw, orig_th = 原始分块尺寸
            scale_w = actual_tile_w / orig_tw if orig_tw > 0 else 1.0
            scale_h = actual_tile_h / orig_th if orig_th > 0 else 1.0
            实际缩放倍率 = (scale_w + scale_h) / 2.0
        else:
            实际缩放倍率 = 1.0

        缩放位置 = []
        for left, upper, right, lower in 分块位置:
            缩放位置.append((
                round(left * 实际缩放倍率),
                round(upper * 实际缩放倍率),
                round(right * 实际缩放倍率),
                round(lower * 实际缩放倍率)
            ))

        scaled_blend_width = round(融合宽度 * 实际缩放倍率)

        row_images = []
        for row in range(num_rows):
            row_image = tensor2pil(分块图像_批次[row * num_cols].unsqueeze(0))
            for col in range(1, num_cols):
                index = row * num_cols + col
                tile_image = tensor2pil(分块图像_批次[index].unsqueeze(0))
                prev_right = 缩放位置[index - 1][2]
                left = 缩放位置[index][0]
                overlap_width = prev_right - left
                if overlap_width > 0:
                    row_image = self._blend_tiles(row_image, tile_image, overlap_width, 'horizontal', scaled_blend_width)
                else:
                    new_width = row_image.width + tile_image.width
                    new_height = max(row_image.height, tile_image.height)
                    new_row_image = Image.new("RGB", (new_width, new_height))
                    new_row_image.paste(row_image, (0, 0))
                    new_row_image.paste(tile_image, (row_image.width, 0))
                    row_image = new_row_image
            row_images.append(row_image)

        final_image = row_images[0]
        for row in range(1, num_rows):
            prev_lower = 缩放位置[(row - 1) * num_cols][3]
            upper = 缩放位置[row * num_cols][1]
            overlap_height = prev_lower - upper
            if overlap_height > 0:
                final_image = self._blend_tiles(final_image, row_images[row], overlap_height, 'vertical', scaled_blend_width)
            else:
                new_width = max(final_image.width, row_images[row].width)
                new_height = final_image.height + row_images[row].height
                new_final_image = Image.new("RGB", (new_width, new_height))
                new_final_image.paste(final_image, (0, 0))
                new_final_image.paste(row_images[row], (0, final_image.height))
                final_image = new_final_image

        return pil2tensor(final_image).unsqueeze(0)


OVERLAP_PRESETS = {
    "无": 0,
    "1/16 分块": 0.0625,
    "1/4 分块": 0.25,
    "1/2 分块": 0.5,
}

RESOLUTION_DIVIDER_DESC = """根据分块尺寸自动计算网格数，将图像裁剪为带重叠的分块批次，可直接连接到拼接节点。

运行逻辑：
1. 根据图像宽高和分块宽高计算行列数。
2. 根据重叠预设计算实际重叠像素，调整网格使其覆盖完整图像。
3. 按网格裁剪所有分块，输出批次和分块信息。"""


class ImageResolutionDivider:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "图像": ("IMAGE", {
                    "tooltip": "输入图像。"
                }),
                "分块宽度": ("INT", {
                    "default": 1024, "min": 64, "max": 16384, "step": 64,
                    "tooltip": "每个分块的宽度（像素）。"
                }),
                "分块高度": ("INT", {
                    "default": 1024, "min": 64, "max": 16384, "step": 64,
                    "tooltip": "每个分块的高度（像素）。"
                }),
                "重叠预设": (list(OVERLAP_PRESETS.keys()), {
                    "default": "1/4 分块",
                    "tooltip": "相邻分块的重叠比例预设。分块越多重叠越大，拼接越平滑。"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "TILE_INFO", "STRING")
    RETURN_NAMES = ("分块图像_批次", "分块信息", "信息预览")
    FUNCTION = "execute"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像操作"
    DESCRIPTION = RESOLUTION_DIVIDER_DESC

    def execute(self, 图像, 分块宽度, 分块高度, 重叠预设):
        overlap_fraction = OVERLAP_PRESETS.get(重叠预设, 0.03125)

        _, height, width, _ = 图像.shape

        overlap_x = int(overlap_fraction * 分块宽度)
        overlap_y = int(overlap_fraction * 分块高度)

        step_x = max(1, 分块宽度 - overlap_x)
        step_y = max(1, 分块高度 - overlap_y)

        grid_x = max(1, math.ceil((width - 分块宽度) / step_x) + 1) if width > 分块宽度 else 1
        grid_y = max(1, math.ceil((height - 分块高度) / step_y) + 1) if height > 分块高度 else 1

        image = tensor2pil(图像.squeeze(0))

        positions = []
        tiles = []
        for row in range(grid_y):
            y = row * step_y
            if row == grid_y - 1 and grid_y > 1:
                y = max(0, height - 分块高度)
            for col in range(grid_x):
                x = col * step_x
                if col == grid_x - 1 and grid_x > 1:
                    x = max(0, width - 分块宽度)
                x = max(0, x)
                y = max(0, y)
                right = min(x + 分块宽度, width)
                lower = min(y + 分块高度, height)
                left = right - 分块宽度 if right - x < 分块宽度 else x
                upper = lower - 分块高度 if lower - y < 分块高度 else y
                left = max(0, left)
                upper = max(0, upper)
                positions.append((left, upper, right, lower))
                tile = image.crop((left, upper, right, lower))
                tiles.append(pil2tensor(tile))

        tile_batch = torch.stack(tiles, dim=0).squeeze(1)
        tile_info = make_tile_info(positions, (width, height), (grid_x, grid_y), (分块宽度, 分块高度))

        actual_overlap_x = 分块宽度 - step_x if grid_x > 1 else 0
        actual_overlap_y = 分块高度 - step_y if grid_y > 1 else 0
        info_text = (
            f"原图尺寸: {width}x{height}\n"
            f"分块尺寸: {分块宽度}x{分块高度}\n"
            f"网格: {grid_x}x{grid_y} ({grid_x * grid_y} 分块)\n"
            f"重叠 X: {actual_overlap_x} 像素\n"
            f"重叠 Y: {actual_overlap_y} 像素"
        )

        return (tile_batch, tile_info, info_text)


NODE_CLASS_MAPPINGS = {
    'BrotherPao_ImageTileBatch': ImageTileBatch,
    'BrotherPao_ImageAssemble': ImageAssemble,
    'BrotherPao_ImageResolutionDivider': ImageResolutionDivider,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    'BrotherPao_ImageTileBatch': '图像分块_按数量',
    'BrotherPao_ImageResolutionDivider': '图像分块_按分辨率',
    'BrotherPao_ImageAssemble': '图像分块_拼接',
}
