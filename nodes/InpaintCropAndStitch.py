import comfy.model_management
import math
import nodes
import numpy as np
import torch
import torch.nn.functional as TF
import torchvision.transforms.functional as F
from PIL import Image
from scipy.ndimage import gaussian_filter, grey_dilation, binary_closing, binary_fill_holes
from abc import ABC, abstractmethod

from comfy_api.latest import io


class ProcessorLogic(ABC):
    @abstractmethod
    def expand_m(self, samples, pixels):
        pass

    @abstractmethod
    def blur_m(self, samples, pixels):
        pass

    @abstractmethod
    def batched_findcontextarea_m(self, mask):
        pass

    def rescale(self, samples, width, height, algorithm: str, is_image=True):
        original_device = samples.device
        if is_image:
            samples = samples.movedim(-1, 1)
        algorithm_enum = getattr(Image, algorithm.upper())
        results = []
        for i in range(samples.shape[0]):
            samples_pil: Image.Image = F.to_pil_image(samples[i].float().cpu()).resize((width, height), algorithm_enum)
            tensor = F.to_tensor(samples_pil)
            if not is_image:
                tensor = tensor.squeeze(0)
            results.append(tensor)
        samples = torch.stack(results, dim=0).to(original_device)
        if is_image:
            samples = samples.movedim(1, -1)
        return samples

    def rescale_i(self, samples, width, height, algorithm: str):
        return self.rescale(samples, width, height, algorithm, is_image=True)

    def rescale_m(self, samples, width, height, algorithm: str):
        return self.rescale(samples, width, height, algorithm, is_image=False)

    def fillholes_iterative_hipass_fill_m(self, samples):
        original_device = samples.device
        thresholds = [1, 0.99, 0.97, 0.95, 0.93, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
        results = []
        for i in range(samples.shape[0]):
            mask_np = samples[i].cpu().numpy()
            for threshold in thresholds:
                thresholded_mask = mask_np >= threshold
                closed_mask = binary_closing(thresholded_mask, structure=np.ones((3, 3)), border_value=1)
                filled_mask = binary_fill_holes(closed_mask)
                mask_np = np.maximum(mask_np, np.where(filled_mask != 0, threshold, 0))
            results.append(torch.from_numpy(mask_np.astype(np.float32)))
        return torch.stack(results, dim=0).to(original_device)

    def hipassfilter_m(self, samples, threshold):
        filtered_mask = samples.clone()
        filtered_mask[filtered_mask < threshold] = 0
        return filtered_mask

    def invert_m(self, samples):
        return 1.0 - samples.clone()

    def debug_context_location_in_image(self, image, x, y, w, h):
        debug_image = image.clone()
        debug_image[:, y:y+h, x:x+w, :] = 1.0 - debug_image[:, y:y+h, x:x+w, :]
        return debug_image

    def pad_to_multiple(self, value, multiple):
        return int(math.ceil(value / multiple) * multiple)

    def batched_growcontextarea_m(self, mask, x, y, w, h, extend_factor):
        img_h, img_w = mask.shape[1], mask.shape[2]

        grow_x = (w.float() * (extend_factor - 1.0) / 2.0).round().long()
        grow_y = (h.float() * (extend_factor - 1.0) / 2.0).round().long()

        new_x = torch.clamp(x - grow_x, min=0)
        new_y = torch.clamp(y - grow_y, min=0)
        new_x2 = torch.clamp(x + w + grow_x, max=img_w)
        new_y2 = torch.clamp(y + h + grow_y, max=img_h)

        new_w = new_x2 - new_x
        new_h = new_y2 - new_y

        empty = (w == -1)
        new_x[empty] = 0
        new_y[empty] = 0
        new_w[empty] = img_w
        new_h[empty] = img_h

        return None, new_x, new_y, new_w, new_h

    def batched_combinecontextmask_m(self, mask, x, y, w, h, optional_context_mask):
        _, ox, oy, ow, oh = self.batched_findcontextarea_m(optional_context_mask)

        mask_x_neg1 = (x == -1)
        x_1 = torch.where(mask_x_neg1, ox, x)
        y_1 = torch.where(mask_x_neg1, oy, y)
        w_1 = torch.where(mask_x_neg1, ow, w)
        h_1 = torch.where(mask_x_neg1, oh, h)

        mask_ox_neg1 = (ox == -1)
        ox_2 = torch.where(mask_ox_neg1, x_1, ox)
        oy_2 = torch.where(mask_ox_neg1, y_1, oy)
        ow_2 = torch.where(mask_ox_neg1, w_1, ow)
        oh_2 = torch.where(mask_ox_neg1, h_1, oh)

        new_x = torch.min(x_1, ox_2)
        new_y = torch.min(y_1, oy_2)
        new_x_max = torch.max(x_1 + w_1, ox_2 + ow_2)
        new_y_max = torch.max(y_1 + h_1, oy_2 + oh_2)
        new_w = new_x_max - new_x
        new_h = new_y_max - new_y

        both_empty = (x_1 == -1)
        new_x[both_empty] = -1
        new_y[both_empty] = -1
        new_w[both_empty] = -1
        new_h[both_empty] = -1

        return None, new_x, new_y, new_w, new_h

    def _adjust_axis_bounds(self, new_pos, new_size, image_size):
        if new_pos < 0:
            shift = -new_pos
            if new_pos + new_size + shift <= image_size:
                new_pos += shift
            else:
                new_pos = -((new_size - image_size) // 2)
        elif new_pos + new_size > image_size:
            overflow = new_pos + new_size - image_size
            if new_pos - overflow >= 0:
                new_pos -= overflow
            else:
                new_pos = -((new_size - image_size) // 2)
        return new_pos

    def _expand_canvas_with_edge_replication(self, image, image_h, image_w, up_padding, down_padding, left_padding, right_padding):
        expanded_image = torch.zeros((image.shape[0], image_h + up_padding + down_padding, image_w + left_padding + right_padding, image.shape[3]), device=image.device)
        image = image.permute(0, 3, 1, 2)
        expanded_image = expanded_image.permute(0, 3, 1, 2)

        expanded_image[:, :, up_padding:up_padding + image_h, left_padding:left_padding + image_w] = image

        if up_padding > 0:
            expanded_image[:, :, :up_padding, left_padding:left_padding + image_w] = expanded_image[:, :, up_padding:up_padding + 1, left_padding:left_padding + image_w].repeat(1, 1, up_padding, 1)
        if down_padding > 0:
            expanded_image[:, :, -down_padding:, left_padding:left_padding + image_w] = expanded_image[:, :, up_padding + image_h - 1:up_padding + image_h, left_padding:left_padding + image_w].repeat(1, 1, down_padding, 1)
        if left_padding > 0:
            expanded_image[:, :, up_padding:up_padding + image_h, :left_padding] = expanded_image[:, :, up_padding:up_padding + image_h, left_padding:left_padding+1].repeat(1, 1, 1, left_padding)
        if right_padding > 0:
            expanded_image[:, :, up_padding:up_padding + image_h, -right_padding:] = expanded_image[:, :, up_padding:up_padding + image_h, -right_padding-1:-right_padding].repeat(1, 1, 1, right_padding)

        expanded_image = expanded_image.permute(0, 2, 3, 1)
        return expanded_image

    def _compute_crop_bounds(self, x, y, w, h, target_w, target_h, image_w, image_h, resize_output):
        target_aspect_ratio = target_w / target_h
        context_aspect_ratio = w / h
        if context_aspect_ratio < target_aspect_ratio:
            new_w = int(h * target_aspect_ratio)
            new_h = h
            new_x = x - (new_w - w) // 2
            new_y = y
            new_x = self._adjust_axis_bounds(new_x, new_w, image_w)
        else:
            new_w = w
            new_h = int(w / target_aspect_ratio)
            new_x = x
            new_y = y - (new_h - h) // 2
            new_y = self._adjust_axis_bounds(new_y, new_h, image_h)

        if not resize_output:
            if new_w < target_w:
                new_x -= (target_w - new_w) // 2
                new_w = target_w
                new_x = self._adjust_axis_bounds(new_x, new_w, image_w)
            if new_h < target_h:
                new_y -= (target_h - new_h) // 2
                new_h = target_h
                new_y = self._adjust_axis_bounds(new_y, new_h, image_h)

        return new_x, new_y, new_w, new_h

    def crop_magic_im(self, image, mask, x, y, w, h, target_w, target_h, padding, downscale_algorithm, upscale_algorithm, resize_output=True):
        image = image.clone()
        mask = mask.clone()

        if target_w <= 0 or target_h <= 0 or w == 0 or h == 0:
            return image, 0, 0, image.shape[2], image.shape[1], image, mask, 0, 0, image.shape[2], image.shape[1]

        if padding != 0:
            target_w = self.pad_to_multiple(target_w, padding)
            target_h = self.pad_to_multiple(target_h, padding)

        B, image_h, image_w, C = image.shape
        new_x, new_y, new_w, new_h = self._compute_crop_bounds(x, y, w, h, target_w, target_h, image_w, image_h, resize_output)

        up_padding = max(-new_y, 0)
        down_padding = max(new_y + new_h - image_h, 0)
        left_padding = max(-new_x, 0)
        right_padding = max(new_x + new_w - image_w, 0)

        expanded_image = self._expand_canvas_with_edge_replication(image, image_h, image_w, up_padding, down_padding, left_padding, right_padding)
        expanded_mask = torch.zeros((mask.shape[0], image_h + up_padding + down_padding, image_w + left_padding + right_padding), device=mask.device)
        expanded_mask[:, up_padding:up_padding + image_h, left_padding:left_padding + image_w] = mask

        cto_x = left_padding
        cto_y = up_padding
        cto_w = image_w
        cto_h = image_h

        canvas_image = expanded_image
        canvas_mask = expanded_mask

        ctc_x = new_x+left_padding
        ctc_y = new_y+up_padding
        ctc_w = new_w
        ctc_h = new_h

        cropped_image = canvas_image[:, ctc_y:ctc_y + ctc_h, ctc_x:ctc_x + ctc_w]
        cropped_mask = canvas_mask[:, ctc_y:ctc_y + ctc_h, ctc_x:ctc_x + ctc_w]

        if resize_output:
            if target_w > ctc_w or target_h > ctc_h:
                cropped_image = self.rescale_i(cropped_image, target_w, target_h, upscale_algorithm)
                cropped_mask = self.rescale_m(cropped_mask, target_w, target_h, upscale_algorithm)
            else:
                cropped_image = self.rescale_i(cropped_image, target_w, target_h, downscale_algorithm)
                cropped_mask = self.rescale_m(cropped_mask, target_w, target_h, downscale_algorithm)

        return canvas_image, cto_x, cto_y, cto_w, cto_h, cropped_image, cropped_mask, ctc_x, ctc_y, ctc_w, ctc_h

    def stitch_magic_im(self, canvas_image, inpainted_image, mask, ctc_x, ctc_y, ctc_w, ctc_h, cto_x, cto_y, cto_w, cto_h, downscale_algorithm, upscale_algorithm):
        canvas_image = canvas_image.clone()
        inpainted_image = inpainted_image.clone()
        mask = mask.clone()

        B, h, w, _ = inpainted_image.shape
        if ctc_w > w or ctc_h > h:
            resized_image = self.rescale_i(inpainted_image, ctc_w, ctc_h, upscale_algorithm)
            resized_mask = self.rescale_m(mask, ctc_w, ctc_h, upscale_algorithm)
        else:
            resized_image = self.rescale_i(inpainted_image, ctc_w, ctc_h, downscale_algorithm)
            resized_mask = self.rescale_m(mask, ctc_w, ctc_h, downscale_algorithm)

        resized_mask = resized_mask.clamp(0, 1).unsqueeze(-1)

        canvas_crop = canvas_image[:, ctc_y:ctc_y + ctc_h, ctc_x:ctc_x + ctc_w]

        blended = resized_mask * resized_image + (1.0 - resized_mask) * canvas_crop

        canvas_image[:, ctc_y:ctc_y + ctc_h, ctc_x:ctc_x + ctc_w] = blended

        output_image = canvas_image[:, cto_y:cto_y + cto_h, cto_x:cto_x + cto_w]

        return output_image


class CPUProcessorLogic(ProcessorLogic):
    def expand_m(self, mask, pixels):
        sigma = pixels / 4
        kernel_size = math.ceil(sigma * 1.5 + 1)
        kernel = np.ones((kernel_size, kernel_size), dtype=np.uint8)
        results = []
        for i in range(mask.shape[0]):
            mask_np = mask[i].cpu().numpy()
            dilated_mask = grey_dilation(mask_np, footprint=kernel, mode='reflect')
            results.append(torch.from_numpy(dilated_mask.astype(np.float32)).clamp(0.0, 1.0))
        return torch.stack(results, dim=0)

    def blur_m(self, samples, pixels):
        sigma = pixels / 4
        results = []
        for i in range(samples.shape[0]):
            mask_np = samples[i].cpu().numpy()
            blurred_mask = gaussian_filter(mask_np, sigma=sigma, mode='reflect')
            results.append(torch.from_numpy(blurred_mask).float().clamp(0.0, 1.0))
        return torch.stack(results, dim=0)

    def batched_findcontextarea_m(self, mask):
        B, H, W = mask.shape
        device = mask.device

        x_list, y_list, w_list, h_list = [], [], [], []
        for i in range(B):
            mask_squeezed = mask[i]
            non_zero_indices = torch.nonzero(mask_squeezed)
            if non_zero_indices.numel() == 0:
                bx, by, bw, bh = -1, -1, -1, -1
            else:
                by = torch.min(non_zero_indices[:, 0]).item()
                bx = torch.min(non_zero_indices[:, 1]).item()
                by_max = torch.max(non_zero_indices[:, 0]).item()
                bx_max = torch.max(non_zero_indices[:, 1]).item()
                bw = bx_max - bx + 1
                bh = by_max - by + 1
            x_list.append(bx)
            y_list.append(by)
            w_list.append(bw)
            h_list.append(bh)
        return None, torch.tensor(x_list, device=device), torch.tensor(y_list, device=device), torch.tensor(w_list, device=device), torch.tensor(h_list, device=device)


class GPUProcessorLogic(ProcessorLogic):
    def expand_m(self, mask, pixels):
        sigma = pixels / 4
        kernel_size = math.ceil(sigma * 1.5 + 1)
        if kernel_size % 2 == 0:
            kernel_size += 1

        padding = kernel_size // 2

        mask_in = mask.unsqueeze(1)

        mask_padded = TF.pad(mask_in, (padding, padding, padding, padding), mode='reflect')

        dilated = TF.max_pool2d(mask_padded, kernel_size=kernel_size, stride=1, padding=0)

        return dilated.squeeze(1)

    def blur_m(self, samples, pixels):
        sigma = pixels / 4
        kernel_size = 2 * int(4.0 * sigma + 0.5) + 1

        x = torch.arange(kernel_size, device=samples.device, dtype=samples.dtype) - (kernel_size - 1) / 2
        kernel_1d = torch.exp(-0.5 * (x / sigma).pow(2))
        kernel_1d = kernel_1d / kernel_1d.sum()

        kernel_2d = kernel_1d.unsqueeze(1) * kernel_1d.unsqueeze(0)
        kernel_2d = kernel_2d.expand(1, 1, kernel_size, kernel_size)

        mask_in = samples.unsqueeze(1)
        pad = kernel_size // 2

        mask_padded = TF.pad(mask_in, (pad, pad, pad, pad), mode='reflect')
        blurred = TF.conv2d(mask_padded, kernel_2d, padding=0, groups=1)

        return blurred.squeeze(1).clamp(0.0, 1.0)

    def batched_findcontextarea_m(self, mask):
        B, H, W = mask.shape
        device = mask.device

        any_y = mask.max(dim=2).values > 0.
        any_x = mask.max(dim=1).values > 0.

        def get_min_max(any_dim, size):
            indices = torch.arange(size, device=device).unsqueeze(0).expand(B, -1)
            min_indices = torch.where(any_dim, indices, torch.tensor(size, device=device))
            max_indices = torch.where(any_dim, indices, torch.tensor(-1, device=device))

            b_min = torch.min(min_indices, dim=1).values
            b_max = torch.max(max_indices, dim=1).values

            empty = ~any_dim.any(dim=1)
            b_min[empty] = -1
            b_max[empty] = -1

            return b_min, b_max

        y_min, y_max = get_min_max(any_y, H)
        x_min, x_max = get_min_max(any_x, W)

        w = torch.where(x_min >= 0, x_max - x_min + 1, torch.tensor(-1, device=device))
        h = torch.where(y_min >= 0, y_max - y_min + 1, torch.tensor(-1, device=device))

        return None, x_min, y_min, w, h


class InpaintCropImproved(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        algorithms = ["nearest", "bilinear", "bicubic", "lanczos", "box", "hamming"]
        return io.Schema(
            node_id="BrotherPao_InpaintCropImproved",
            display_name="内补裁剪",
            category="❤️‍🩹炮哥Nodes/图像内补拼接",
            description="根据遮罩裁剪图像用于内补绘制。上下文遮罩用于定义额外的保留区域作为上下文参考。",
            inputs=[
                io.Image.Input("image"),
                io.Combo.Input("downscale_algorithm", options=algorithms, default="bilinear", tooltip="缩小时使用的缩放算法"),
                io.Combo.Input("upscale_algorithm", options=algorithms, default="bicubic", tooltip="放大时使用的缩放算法"),
                io.Boolean.Input("mask_fill_holes", default=True, tooltip="填充遮罩中被完全包围的空洞区域"),
                io.Int.Input("mask_expand_pixels", default=0, min=0, max=nodes.MAX_RESOLUTION, step=1, tooltip="处理前将遮罩向外扩展的像素数"),
                io.Boolean.Input("mask_invert", default=False, tooltip="反转遮罩，使遮罩区域变为保留区域"),
                io.Int.Input("mask_blend_pixels", default=64, min=0, max=128, step=1, tooltip="与原始图像混合的过渡像素数"),
                io.Float.Input("mask_hipass_filter", default=0.1, min=0, max=1, step=0.01, tooltip="忽略低于此值的遮罩像素"),
                io.Float.Input("context_from_mask_extend_factor", default=1.2, min=1.0, max=100.0, step=0.01, tooltip="从遮罩区域向外扩展上下文的倍数。例如 1.5 表示每个方向额外扩展 50%"),
                io.Boolean.Input("output_resize_to_target_size", default=True, tooltip="强制缩放到指定分辨率进行采样"),
                io.Int.Input("output_target_width", default=1024, min=64, max=nodes.MAX_RESOLUTION, step=1, tooltip="输出目标宽度"),
                io.Int.Input("output_target_height", default=1024, min=64, max=nodes.MAX_RESOLUTION, step=1, tooltip="输出目标高度"),
                io.Combo.Input("output_padding", options=["0", "8", "16", "32", "64", "128", "256", "512"], default="32", tooltip="将输出尺寸对齐到此值的倍数"),
                io.Combo.Input("device_mode", options=["cpu", "gpu"], default="gpu", tooltip="计算设备选择"),
                io.Mask.Input("mask", optional=True, tooltip="内补绘制遮罩，白色为需要重绘的区域"),
                io.Mask.Input("optional_context_mask", optional=True, tooltip="上下文遮罩，定义额外的保留区域作为上下文参考"),
            ],
            outputs=[
                io.Custom("STITCHER").Output(display_name="stitcher"),
                io.Image.Output(display_name="cropped_image"),
                io.Mask.Output(display_name="cropped_mask"),
            ],
        )

    @classmethod
    def execute(cls, image, downscale_algorithm, upscale_algorithm, mask_fill_holes, mask_expand_pixels, mask_invert, mask_blend_pixels, mask_hipass_filter, context_from_mask_extend_factor, output_resize_to_target_size, output_target_width, output_target_height, output_padding, device_mode, mask=None, optional_context_mask=None):
        image = image.clone()
        if mask is not None:
            mask = mask.clone()
            if mask.ndim == 2:
                mask = mask.unsqueeze(0)
        if optional_context_mask is not None:
            optional_context_mask = optional_context_mask.clone()
            if optional_context_mask.ndim == 2:
                optional_context_mask = optional_context_mask.unsqueeze(0)

        if device_mode == "gpu":
            device = comfy.model_management.get_torch_device()
            image = image.to(device)
            if mask is not None:
                mask = mask.to(device)
            if optional_context_mask is not None:
                optional_context_mask = optional_context_mask.to(device)
            processor = GPUProcessorLogic()
        else:
            processor = CPUProcessorLogic()

        output_padding = int(output_padding)

        if image.shape[0] > 1:
            assert output_resize_to_target_size, "批量图像输入时必须启用缩放到目标尺寸"

        if mask is not None and (image.shape[0] == 1 or mask.shape[0] == 1 or mask.shape[0] == image.shape[0]):
            if mask.shape[1] != image.shape[1] or mask.shape[2] != image.shape[2]:
                if torch.count_nonzero(mask) == 0:
                    mask = torch.zeros((mask.shape[0], image.shape[1], image.shape[2]), device=image.device, dtype=image.dtype)

        if optional_context_mask is not None and (image.shape[0] == 1 or optional_context_mask.shape[0] == 1 or optional_context_mask.shape[0] == image.shape[0]):
            if optional_context_mask.shape[1] != image.shape[1] or optional_context_mask.shape[2] != image.shape[2]:
                if torch.count_nonzero(optional_context_mask) == 0:
                    optional_context_mask = torch.zeros((optional_context_mask.shape[0], image.shape[1], image.shape[2]), device=image.device, dtype=image.dtype)

        if mask is None:
            mask = torch.zeros_like(image[:, :, :, 0])

        if mask.shape[0] > 1 and image.shape[0] == 1:
            assert image.dim() == 4, f"Expected 4D BHWC image tensor, got {image.shape}"
            image = image.expand(mask.shape[0], -1, -1, -1).clone()

        if image.shape[0] > 1 and mask.shape[0] == 1:
            assert mask.dim() == 3, f"Expected 3D BHW mask tensor, got {mask.shape}"
            mask = mask.expand(image.shape[0], -1, -1).clone()

        if optional_context_mask is None:
            optional_context_mask = torch.zeros_like(image[:, :, :, 0])

        if image.shape[0] > 1 and optional_context_mask.shape[0] == 1:
            assert optional_context_mask.dim() == 3, f"Expected 3D BHW optional_context_mask tensor, got {optional_context_mask.shape}"
            optional_context_mask = optional_context_mask.expand(image.shape[0], -1, -1).clone()

        assert image.ndimension() == 4, f"Expected 4 dimensions for image, got {image.ndimension()}"
        assert mask.ndimension() == 3, f"Expected 3 dimensions for mask, got {mask.ndimension()}"
        assert optional_context_mask.ndimension() == 3, f"Expected 3 dimensions for optional_context_mask, got {optional_context_mask.ndimension()}"
        assert mask.shape[1:] == image.shape[1:3], f"Mask dimensions do not match image dimensions. Expected {image.shape[1:3]}, got {mask.shape[1:]}"
        assert optional_context_mask.shape[1:] == image.shape[1:3], f"optional_context_mask dimensions do not match image dimensions. Expected {image.shape[1:3]}, got {optional_context_mask.shape[1:]}"
        assert mask.shape[0] == image.shape[0], f"Mask batch does not match image batch. Expected {image.shape[0]}, got {mask.shape[0]}"
        assert optional_context_mask.shape[0] == image.shape[0], f"Optional context mask batch does not match image batch. Expected {image.shape[0]}, got {optional_context_mask.shape[0]}"

        result_stitcher = {
            'downscale_algorithm': downscale_algorithm,
            'upscale_algorithm': upscale_algorithm,
            'canvas_to_orig_x': [],
            'canvas_to_orig_y': [],
            'canvas_to_orig_w': [],
            'canvas_to_orig_h': [],
            'canvas_image': [],
            'cropped_to_canvas_x': [],
            'cropped_to_canvas_y': [],
            'cropped_to_canvas_w': [],
            'cropped_to_canvas_h': [],
            'cropped_mask_for_blend': [],
            'device_mode': device_mode,
        }
        result_image = []
        result_mask = []

        batch_size = image.shape[0]

        for i in range(batch_size):
            sub_image = image[i:i+1]
            sub_mask = mask[i:i+1]
            sub_opt_mask = optional_context_mask[i:i+1]

            if mask_fill_holes:
                sub_mask = processor.fillholes_iterative_hipass_fill_m(sub_mask)

            if mask_expand_pixels > 0:
                sub_mask = processor.expand_m(sub_mask, mask_expand_pixels)

            if mask_invert:
                sub_mask = processor.invert_m(sub_mask)

            if mask_blend_pixels > 0:
                sub_mask = processor.expand_m(sub_mask, mask_blend_pixels)
                sub_mask = processor.blur_m(sub_mask, mask_blend_pixels*0.5)

            if mask_hipass_filter >= 0.01:
                sub_mask = processor.hipassfilter_m(sub_mask, mask_hipass_filter)
                sub_opt_mask = processor.hipassfilter_m(sub_opt_mask, mask_hipass_filter)

            _, bx, by, bw, bh = processor.batched_findcontextarea_m(sub_mask)

            if bx[0] == -1:
                bx[0], by[0], bw[0], bh[0] = 0, 0, sub_image.shape[2], sub_image.shape[1]

            if context_from_mask_extend_factor >= 1.01:
                _, bx, by, bw, bh = processor.batched_growcontextarea_m(sub_mask, bx, by, bw, bh, context_from_mask_extend_factor)

            _, bx, by, bw, bh = processor.batched_combinecontextmask_m(sub_mask, bx, by, bw, bh, sub_opt_mask)

            if bx[0] == -1:
                bx[0], by[0], bw[0], bh[0] = 0, 0, sub_image.shape[2], sub_image.shape[1]

            cur_x, cur_y, cur_w, cur_h = bx[0].item(), by[0].item(), bw[0].item(), bh[0].item()

            if output_resize_to_target_size:
                canvas_image, cto_x, cto_y, cto_w, cto_h, cropped_image, cropped_mask, ctc_x, ctc_y, ctc_w, ctc_h = processor.crop_magic_im(
                    sub_image, sub_mask, cur_x, cur_y, cur_w, cur_h, output_target_width, output_target_height, output_padding, downscale_algorithm, upscale_algorithm, resize_output=True
                )
            else:
                canvas_image, cto_x, cto_y, cto_w, cto_h, cropped_image, cropped_mask, ctc_x, ctc_y, ctc_w, ctc_h = processor.crop_magic_im(
                    sub_image, sub_mask, cur_x, cur_y, cur_w, cur_h, cur_w, cur_h, output_padding, downscale_algorithm, upscale_algorithm, resize_output=False
                )
            p_crop = cropped_image
            p_mask = cropped_mask

            p_mask_blend = p_mask
            if mask_blend_pixels > 0:
                p_mask_blend = processor.blur_m(p_mask_blend, mask_blend_pixels * 0.5)

            result_stitcher['canvas_to_orig_x'].append(cto_x)
            result_stitcher['canvas_to_orig_y'].append(cto_y)
            result_stitcher['canvas_to_orig_w'].append(cto_w)
            result_stitcher['canvas_to_orig_h'].append(cto_h)
            result_stitcher['canvas_image'].append(canvas_image.cpu())
            result_stitcher['cropped_to_canvas_x'].append(ctc_x)
            result_stitcher['cropped_to_canvas_y'].append(ctc_y)
            result_stitcher['cropped_to_canvas_w'].append(ctc_w)
            result_stitcher['cropped_to_canvas_h'].append(ctc_h)
            result_stitcher['cropped_mask_for_blend'].append(p_mask_blend.cpu())

            result_image.append(p_crop.squeeze(0).cpu())
            result_mask.append(p_mask.squeeze(0).cpu())

        result_image = torch.stack(result_image, dim=0)
        result_mask = torch.stack(result_mask, dim=0)

        return io.NodeOutput(result_stitcher, result_image, result_mask)


class InpaintStitchImproved(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_InpaintStitchImproved",
            display_name="内补拼接",
            category="❤️‍🩹炮哥Nodes/图像内补拼接",
            description="将内补绘制后的图像缝合回原始图像，不改变未遮罩区域。",
            inputs=[
                io.Custom("STITCHER").Input("stitcher", tooltip="来自内补裁剪节点的缝合数据"),
                io.Image.Input("inpainted_image", tooltip="内补绘制完成后的图像"),
            ],
            outputs=[io.Image.Output(display_name="image")],
        )

    @classmethod
    def execute(cls, stitcher, inpainted_image):
        inpainted_image = inpainted_image.clone()
        results = []

        device_mode = stitcher.get('device_mode', 'cpu')

        if device_mode == "gpu":
            device = comfy.model_management.get_torch_device()
            inpainted_image = inpainted_image.to(device)
            processor = GPUProcessorLogic()
        else:
            device = torch.device("cpu")
            processor = CPUProcessorLogic()

        for key in ['canvas_image', 'cropped_mask_for_blend']:
            if key in stitcher:
                stitcher[key] = [t.to(device) if torch.is_tensor(t) else t for t in stitcher[key]]

        batch_size = inpainted_image.shape[0]
        assert len(stitcher['cropped_to_canvas_x']) == batch_size or len(stitcher['cropped_to_canvas_x']) == 1, "Stitch batch size doesn't match image batch size"
        override = False
        if len(stitcher['cropped_to_canvas_x']) != batch_size and len(stitcher['cropped_to_canvas_x']) == 1:
            override = True

        for i in range(batch_size):
            one_image = inpainted_image[i:i+1]

            one_stitcher = {}
            for key in ['downscale_algorithm', 'upscale_algorithm']:
                one_stitcher[key] = stitcher[key]
            for key in ['canvas_to_orig_x', 'canvas_to_orig_y', 'canvas_to_orig_w', 'canvas_to_orig_h', 'canvas_image', 'cropped_to_canvas_x', 'cropped_to_canvas_y', 'cropped_to_canvas_w', 'cropped_to_canvas_h', 'cropped_mask_for_blend']:
                if override:
                    one_stitcher[key] = stitcher[key][0]
                else:
                    one_stitcher[key] = stitcher[key][i]

            one_image, = cls.inpaint_stitch_single_image(one_stitcher, one_image, processor)
            results.append(one_image.squeeze(0))

        result_batch = torch.stack(results, dim=0)
        result_batch = result_batch.cpu()

        return io.NodeOutput(result_batch)

    @staticmethod
    def inpaint_stitch_single_image(stitcher, inpainted_image, processor):
        downscale_algorithm = stitcher['downscale_algorithm']
        upscale_algorithm = stitcher['upscale_algorithm']
        canvas_image = stitcher['canvas_image']

        ctc_x = stitcher['cropped_to_canvas_x']
        ctc_y = stitcher['cropped_to_canvas_y']
        ctc_w = stitcher['cropped_to_canvas_w']
        ctc_h = stitcher['cropped_to_canvas_h']

        cto_x = stitcher['canvas_to_orig_x']
        cto_y = stitcher['canvas_to_orig_y']
        cto_w = stitcher['canvas_to_orig_w']
        cto_h = stitcher['canvas_to_orig_h']

        mask = stitcher['cropped_mask_for_blend']

        output_image = processor.stitch_magic_im(canvas_image, inpainted_image, mask, ctc_x, ctc_y, ctc_w, ctc_h, cto_x, cto_y, cto_w, cto_h, downscale_algorithm, upscale_algorithm)

        return (output_image,)
