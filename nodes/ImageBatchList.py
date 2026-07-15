import torch

import comfy.utils
from comfy_api.latest import io


CATEGORY = "❤️‍🩹炮哥Nodes/图像操作"


def _ensure_batched_image(image: torch.Tensor) -> torch.Tensor:
    if not isinstance(image, torch.Tensor):
        raise TypeError("图像输入必须是 torch.Tensor。")
    if image.ndim == 3:
        image = image.unsqueeze(0)
    if image.ndim != 4:
        raise ValueError(
            f"图像输入必须是 H×W×C 或 B×H×W×C，当前维度为 {image.ndim}。"
        )
    return image


def _match_batch_shape(
    image: torch.Tensor,
    *,
    height: int,
    width: int,
    channels: int,
    device: torch.device,
    dtype: torch.dtype,
) -> torch.Tensor:
    image = _ensure_batched_image(image).to(device=device, dtype=dtype)

    if image.shape[-1] < channels:
        padding = image.new_ones((*image.shape[:-1], channels - image.shape[-1]))
        image = torch.cat((image, padding), dim=-1)

    if image.shape[1] != height or image.shape[2] != width:
        image = comfy.utils.common_upscale(
            image.movedim(-1, 1),
            width,
            height,
            "lanczos",
            "center",
        ).movedim(1, -1)

    return image


class ImageBatchToImageList(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_ImageBatchToImageList",
            display_name="图像批次转图像列表",
            category=CATEGORY,
            description="将 IMAGE 批次沿批次维拆分为按原顺序排列的 IMAGE 列表。",
            search_aliases=[
                "图像批次转列表",
                "批次转列表",
                "Image Batch to Image List",
                "batch to list",
            ],
            inputs=[
                io.Image.Input(
                    "image_batch",
                    display_name="图像批次",
                    tooltip="需要逐张拆分的 IMAGE 批次。",
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image_list",
                    display_name="图像列表",
                    tooltip="按原批次顺序输出的 IMAGE 列表，每一项包含一张图像。",
                    is_output_list=True,
                ),
            ],
        )

    @classmethod
    def execute(cls, image_batch):
        image_batch = _ensure_batched_image(image_batch)
        image_list = [
            image_batch[index : index + 1].clone()
            for index in range(image_batch.shape[0])
        ]
        return io.NodeOutput(image_list)


class ImageListToImageBatch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="BrotherPao_ImageListToImageBatch",
            display_name="图像列表转图像批次",
            category=CATEGORY,
            description=(
                "将 IMAGE 列表按原顺序合并为一个 IMAGE 批次；不同分辨率会缩放到列表首项的分辨率。"
            ),
            search_aliases=[
                "图像列表转批次",
                "列表转批次",
                "Image List to Image Batch",
                "list to batch",
            ],
            is_input_list=True,
            inputs=[
                io.Image.Input(
                    "image_list",
                    display_name="图像列表",
                    tooltip="需要按顺序合并的 IMAGE 列表，也可接收单个 IMAGE。",
                ),
            ],
            outputs=[
                io.Image.Output(
                    "image_batch",
                    display_name="图像批次",
                    tooltip="按列表顺序合并后的 IMAGE 批次。",
                ),
            ],
        )

    @classmethod
    def execute(cls, image_list):
        if not image_list:
            raise ValueError("图像列表为空，无法转换为图像批次。")

        images = [_ensure_batched_image(image) for image in image_list]
        first_image = images[0]
        target_height = first_image.shape[1]
        target_width = first_image.shape[2]
        target_channels = max(image.shape[-1] for image in images)

        matched_images = [
            _match_batch_shape(
                image,
                height=target_height,
                width=target_width,
                channels=target_channels,
                device=first_image.device,
                dtype=first_image.dtype,
            )
            for image in images
        ]
        return io.NodeOutput(torch.cat(matched_images, dim=0))
