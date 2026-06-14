from PIL import Image
import torch
from torch import Tensor
from torch.nn import functional as F
from torchvision.transforms import ToTensor, ToPILImage

from comfy_api.latest import io

from .utils import pil2tensor, tensor2pil


def _pil_to_norm_tensor(pil_image: Image) -> Tensor:
    return ToTensor()(pil_image).unsqueeze(0)


def _norm_tensor_to_pil(tensor: Tensor) -> Image:
    return ToPILImage()(tensor.squeeze(0).clamp_(0.0, 1.0))


def calc_mean_std(feat: Tensor, eps=1e-5):
    size = feat.size()
    assert len(size) == 4, 'The input feature should be 4D tensor.'
    b, c = size[:2]
    feat_var = feat.view(b, c, -1).var(dim=2) + eps
    feat_std = feat_var.sqrt().view(b, c, 1, 1)
    feat_mean = feat.view(b, c, -1).mean(dim=2).view(b, c, 1, 1)
    return feat_mean, feat_std


def adaptive_instance_normalization(content_feat: Tensor, style_feat: Tensor):
    size = content_feat.size()
    style_mean, style_std = calc_mean_std(style_feat)
    content_mean, content_std = calc_mean_std(content_feat)
    normalized_feat = (content_feat - content_mean.expand(size)) / content_std.expand(size)
    return normalized_feat * style_std.expand(size) + style_mean.expand(size)


def adain_color_fix(target: Image, source: Image):
    target_tensor = _pil_to_norm_tensor(target)
    source_tensor = _pil_to_norm_tensor(source)
    result_tensor = adaptive_instance_normalization(target_tensor, source_tensor)
    return _norm_tensor_to_pil(result_tensor)


def wavelet_blur(image: Tensor, radius: int):
    kernel_vals = [
        [0.0625, 0.125, 0.0625],
        [0.125, 0.25, 0.125],
        [0.0625, 0.125, 0.0625],
    ]
    kernel = torch.tensor(kernel_vals, dtype=image.dtype, device=image.device)
    kernel = kernel[None, None]
    kernel = kernel.repeat(3, 1, 1, 1)
    image = F.pad(image, (radius, radius, radius, radius), mode='replicate')
    output = F.conv2d(image, kernel, groups=3, dilation=radius)
    return output


def wavelet_decomposition(image: Tensor, levels=5):
    high_freq = torch.zeros_like(image)
    for i in range(levels):
        radius = 2 ** i
        low_freq = wavelet_blur(image, radius)
        high_freq += (image - low_freq)
        image = low_freq
    return high_freq, low_freq


def wavelet_reconstruction(content_feat: Tensor, style_feat: Tensor):
    content_high_freq, content_low_freq = wavelet_decomposition(content_feat)
    del content_low_freq
    style_high_freq, style_low_freq = wavelet_decomposition(style_feat)
    del style_high_freq
    return content_high_freq + style_low_freq


def wavelet_color_fix(target: Image, source: Image):
    source = source.resize(target.size, resample=Image.Resampling.LANCZOS)
    target_tensor = _pil_to_norm_tensor(target)
    source_tensor = _pil_to_norm_tensor(source)
    result_tensor = wavelet_reconstruction(target_tensor, source_tensor)
    return _norm_tensor_to_pil(result_tensor)


class ImageColorMatch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_ImageColorMatch",
            display_name="图像颜色匹配",
            category="❤️‍🩹炮哥Nodes/图像操作",
            description="将目标图像的色调/风格匹配到参考图像。支持 wavelet/adain 等传统方法及 color-matcher 库方法。",
            inputs=[
                io.Image.Input("reference_image", tooltip="颜色/风格的参考图像。"),
                io.Image.Input("target_image", tooltip="需要调整颜色的目标图像，会被调整以匹配参考图像的色调。"),
                io.Combo.Input(
                    "method",
                    options=["wavelet", "adain", "mkl", "hm", "reinhard", "mvgd", "hm-mvgd-hm", "hm-mkl-hm"],
                ),
            ],
            outputs=[io.Image.Output(display_name="image")],
        )

    @classmethod
    def execute(cls, reference_image, target_image, method):
        if method in ["wavelet", "adain"]:
            target_pil = tensor2pil(target_image)
            ref_pil = tensor2pil(reference_image)
            result = wavelet_color_fix(target_pil, ref_pil) if method == 'wavelet' else adain_color_fix(target_pil, ref_pil)
            return io.NodeOutput(pil2tensor(result))

        try:
            from color_matcher import ColorMatcher
        except ImportError:
            raise ImportError("需要安装 color-matcher 库。请运行: pip install color-matcher")

        reference_image = reference_image.cpu()
        target_image = target_image.cpu()
        batch_size = target_image.size(0)
        out = []

        images_target = target_image.squeeze()
        images_ref = reference_image.squeeze()

        image_ref_np = images_ref.numpy()
        images_target_np = images_target.numpy()

        if reference_image.size(0) > 1 and reference_image.size(0) != batch_size:
            raise ValueError("ColorMatch: 使用单张参考图或与目标图批次数量相同的参考图。")

        cm = ColorMatcher()
        for i in range(batch_size):
            image_target_np = images_target_np if batch_size == 1 else images_target[i].numpy()
            image_ref_np_i = image_ref_np if reference_image.size(0) == 1 else images_ref[i].numpy()
            image_result = cm.transfer(src=image_target_np, ref=image_ref_np_i, method=method)
            out.append(torch.from_numpy(image_result))

        result = torch.stack(out, dim=0).to(torch.float32)
        return io.NodeOutput(result)
