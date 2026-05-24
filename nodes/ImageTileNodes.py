import math
import numpy as np
import torch
from PIL import Image
from .utils import pil2tensor, tensor2pil


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


IMAGE_TILE_NODE_DESC = """将图像按行列分块数裁剪为带重叠的图像批次。自动计算分块尺寸并对齐到 8 的倍数。拼接节点会根据实际分块尺寸自动适配缩放。"""


class ImageTileBatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "输入图像。"
                }),
                "horizontal_tiles": ("INT", {
                    "default": 3, "min": 1, "max": 10, "step": 1,
                    "tooltip": "水平分块列数，值越大分块越窄。"
                }),
                "vertical_tiles": ("INT", {
                    "default": 3, "min": 1, "max": 10, "step": 1,
                    "tooltip": "垂直分块行数，值越大分块越矮。"
                }),
                "overlap_rate": ("FLOAT", {
                    "default": 0.1, "min": 0.00, "max": 0.95, "step": 0.05,
                    "tooltip": "相邻分块的重叠比例。0=无重叠；0.1=约10%重叠。越大接缝越不明显，推荐 0.05~0.2。"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "TILE_INFO", "INT", "INT")
    RETURN_NAMES = ("tile_batch", "tile_info", "tile_width", "tile_height")
    FUNCTION = "tile_image"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像分块拼接"
    DESCRIPTION = IMAGE_TILE_NODE_DESC

    @staticmethod
    def _calc_axis_tile_size(raw_size, factor, overlap_rate):
        if factor == 1:
            return raw_size
        if overlap_rate == 0:
            tile = int(raw_size / factor)
            if tile % 8 != 0:
                tile = ((tile + 7) // 8) * 8
        else:
            tile = int(raw_size / (1 + (factor - 1) * (1 - overlap_rate)))
            if tile % 8 != 0:
                tile = (tile // 8) * 8
        return tile

    def _calculate_tile_size(self, raw_W, raw_H, width_factor, height_factor, overlap_rate):
        tile_width = self._calc_axis_tile_size(raw_W, width_factor, overlap_rate)
        tile_height = self._calc_axis_tile_size(raw_H, height_factor, overlap_rate)
        return tile_width, tile_height

    def _calculate_step(self, size, tile_size):
        if size <= tile_size:
            return 1, 0
        num_tiles = (size + tile_size - 1) // tile_size
        overlap = (num_tiles * tile_size - size) // (num_tiles - 1)
        step = tile_size - overlap
        return num_tiles, step

    def tile_image(self, image, horizontal_tiles, vertical_tiles, overlap_rate):
        _, raw_H, raw_W, _ = image.shape

        tile_width, tile_height = self._calculate_tile_size(
            raw_W, raw_H, horizontal_tiles, vertical_tiles, overlap_rate
        )

        image_pil = tensor2pil(image.squeeze(0))
        img_width, img_height = image_pil.size

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
                tile = image_pil.crop((left, upper, right, lower))
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
                "tile_batch": ("IMAGE", {
                    "tooltip": "分块图像批次，来自「图像分块 批处理」。"
                }),
                "tile_info": ("TILE_INFO", {
                    "tooltip": "分块信息结构体，来自「图像分块 批处理」。节点自动根据实际分块尺寸推导缩放倍率。"
                }),
                "blend_width": ("INT", {
                    "default": 64, "min": 0,
                    "tooltip": "渐变融合的像素宽度。0=不融合直接拼接；值越大过渡越平滑。会根据缩放倍率等比调整，推荐 32~128。"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("assembled_image",)
    FUNCTION = "assemble_image"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像分块拼接"
    DESCRIPTION = IMAGE_ASSEMBLE_DESC

    def _create_gradient_mask(self, size, direction):
        w, h = size
        if direction == 'horizontal':
            arr = np.linspace(255, 0, w, dtype=np.uint8).reshape(1, -1)
            arr = np.tile(arr, (h, 1))
        else:
            arr = np.linspace(255, 0, h, dtype=np.uint8).reshape(-1, 1)
            arr = np.tile(arr, (1, w))
        return Image.fromarray(arr, mode='L')

    def _blend_tiles(self, tile1, tile2, overlap_size, direction, padding):
        blend_size = min(padding, overlap_size)
        is_h = direction == 'horizontal'

        def tile_dim(t):
            return (t.width, t.height) if is_h else (t.height, t.width)

        main1, cross1 = tile_dim(tile1)
        main2, cross2 = tile_dim(tile2)
        result_main = main1 + main2 - overlap_size
        result_cross = cross1

        if blend_size == 0:
            if is_h:
                result = Image.new("RGB", (result_main, result_cross))
                result.paste(tile1.crop((0, 0, main1 - overlap_size, cross1)), (0, 0))
                result.paste(tile2, (main1 - overlap_size, 0))
            else:
                result = Image.new("RGB", (result_cross, result_main))
                result.paste(tile1.crop((0, 0, cross1, main1 - overlap_size)), (0, 0))
                result.paste(tile2, (0, main1 - overlap_size))
            return result

        offset_total = overlap_size - blend_size
        offset_before = offset_total // 2
        offset_after = offset_total - offset_before

        mask_size = (blend_size, result_cross) if is_h else (result_cross, blend_size)
        mask = self._create_gradient_mask(mask_size, direction)

        if is_h:
            crop1 = tile1.crop((main1 - overlap_size + offset_before, 0, main1 - offset_after, cross1))
            crop2 = tile2.crop((offset_before, 0, offset_before + blend_size, cross2))
        else:
            crop1 = tile1.crop((0, main1 - overlap_size + offset_before, cross1, main1 - offset_after))
            crop2 = tile2.crop((0, offset_before, cross2, offset_before + blend_size))

        if crop1.size != crop2.size:
            raise ValueError(f"Crop sizes do not match: {crop1.size} vs {crop2.size}")
        blended = Image.composite(crop1, crop2, mask)

        if is_h:
            result = Image.new("RGB", (result_main, result_cross))
            result.paste(tile1.crop((0, 0, main1 - overlap_size + offset_before, cross1)), (0, 0))
            result.paste(blended, (main1 - overlap_size + offset_before, 0))
            result.paste(tile2.crop((offset_before + blend_size, 0, main2, cross2)), (main1 - offset_after, 0))
        else:
            result = Image.new("RGB", (result_cross, result_main))
            result.paste(tile1.crop((0, 0, cross1, main1 - overlap_size + offset_before)), (0, 0))
            result.paste(blended, (0, main1 - overlap_size + offset_before))
            result.paste(tile2.crop((0, offset_before + blend_size, cross2, main2)), (0, main1 - offset_after))
        return result

    def assemble_image(self, tile_batch, tile_info, blend_width):
        tile_positions, original_size, grid_size, original_tile_size = unpack_tile_info(tile_info)
        num_cols, num_rows = grid_size

        first_tile = tensor2pil(tile_batch[0].unsqueeze(0))
        actual_tile_w, actual_tile_h = first_tile.size

        if original_tile_size is not None:
            orig_tw, orig_th = original_tile_size
            scale_w = actual_tile_w / orig_tw if orig_tw > 0 else 1.0
            scale_h = actual_tile_h / orig_th if orig_th > 0 else 1.0
            actual_scale_factor = (scale_w + scale_h) / 2.0
        else:
            actual_scale_factor = 1.0

        scaled_positions = []
        for left, upper, right, lower in tile_positions:
            scaled_positions.append((
                round(left * actual_scale_factor),
                round(upper * actual_scale_factor),
                round(right * actual_scale_factor),
                round(lower * actual_scale_factor)
            ))

        scaled_blend_width = round(blend_width * actual_scale_factor)

        row_images = []
        for row in range(num_rows):
            row_image = tensor2pil(tile_batch[row * num_cols].unsqueeze(0))
            for col in range(1, num_cols):
                index = row * num_cols + col
                tile_image = tensor2pil(tile_batch[index].unsqueeze(0))
                prev_right = scaled_positions[index - 1][2]
                left = scaled_positions[index][0]
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
            prev_lower = scaled_positions[(row - 1) * num_cols][3]
            upper = scaled_positions[row * num_cols][1]
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
    "none": 0,
    "1/16 tile": 0.0625,
    "1/4 tile": 0.25,
    "1/2 tile": 0.5,
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
                "image": ("IMAGE", {
                    "tooltip": "输入图像。"
                }),
                "tile_width": ("INT", {
                    "default": 1024, "min": 64, "max": 16384, "step": 64,
                    "tooltip": "每个分块的宽度（像素）。"
                }),
                "tile_height": ("INT", {
                    "default": 1024, "min": 64, "max": 16384, "step": 64,
                    "tooltip": "每个分块的高度（像素）。"
                }),
                "overlap_preset": (list(OVERLAP_PRESETS.keys()), {
                    "default": "1/4 tile",
                    "tooltip": "相邻分块的重叠比例预设。分块越多重叠越大，拼接越平滑。"
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "TILE_INFO", "STRING")
    RETURN_NAMES = ("tile_batch", "tile_info", "info_preview")
    FUNCTION = "execute"
    CATEGORY = "❤️‍🩹炮哥Nodes/图像分块拼接"
    DESCRIPTION = RESOLUTION_DIVIDER_DESC

    def execute(self, image, tile_width, tile_height, overlap_preset):
        overlap_fraction = OVERLAP_PRESETS.get(overlap_preset, 0.03125)

        _, height, width, _ = image.shape

        if tile_width > width:
            tile_width = width
        if tile_height > height:
            tile_height = height

        overlap_x = int(overlap_fraction * tile_width)
        overlap_y = int(overlap_fraction * tile_height)

        step_x = max(1, tile_width - overlap_x)
        step_y = max(1, tile_height - overlap_y)

        grid_x = max(1, math.ceil((width - tile_width) / step_x) + 1) if width > tile_width else 1
        grid_y = max(1, math.ceil((height - tile_height) / step_y) + 1) if height > tile_height else 1

        image_pil = tensor2pil(image.squeeze(0))

        positions = []
        tiles = []
        for row in range(grid_y):
            y = row * step_y
            if row == grid_y - 1 and grid_y > 1:
                y = max(0, height - tile_height)
            for col in range(grid_x):
                x = col * step_x
                if col == grid_x - 1 and grid_x > 1:
                    x = max(0, width - tile_width)
                x = max(0, x)
                y = max(0, y)
                right = min(x + tile_width, width)
                lower = min(y + tile_height, height)
                left = right - tile_width if right - x < tile_width else x
                upper = lower - tile_height if lower - y < tile_height else y
                left = max(0, left)
                upper = max(0, upper)
                positions.append((left, upper, right, lower))
                tile = image_pil.crop((left, upper, right, lower))
                tiles.append(pil2tensor(tile))

        tile_batch = torch.stack(tiles, dim=0).squeeze(1)
        tile_info_obj = make_tile_info(positions, (width, height), (grid_x, grid_y), (tile_width, tile_height))

        actual_overlap_x = tile_width - step_x if grid_x > 1 else 0
        actual_overlap_y = tile_height - step_y if grid_y > 1 else 0
        info_text = (
            f"原图尺寸: {width}x{height}\n"
            f"分块尺寸: {tile_width}x{tile_height}\n"
            f"网格: {grid_x}x{grid_y} ({grid_x * grid_y} 分块)\n"
            f"重叠 X: {actual_overlap_x} 像素\n"
            f"重叠 Y: {actual_overlap_y} 像素"
        )

        return (tile_batch, tile_info_obj, info_text)


NODE_CLASS_MAPPINGS = {
    'BrotherPao_ImageTileBatch': ImageTileBatch,
    'BrotherPao_ImageResolutionDivider': ImageResolutionDivider,
    'BrotherPao_ImageAssemble': ImageAssemble,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    'BrotherPao_ImageTileBatch': '图像分块_按数量',
    'BrotherPao_ImageResolutionDivider': '图像分块_按分辨率',
    'BrotherPao_ImageAssemble': '图像分块_拼接',
}
