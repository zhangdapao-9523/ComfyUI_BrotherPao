import numpy as np
import torch
from PIL import Image
from typing import Optional


def pil2tensor(image: Image, unsqueeze: bool = True, device: Optional[str] = None) -> torch.Tensor:
    tensor = torch.from_numpy(np.array(image).astype(np.float32) / 255.0)
    if unsqueeze:
        tensor = tensor.unsqueeze(0)
    if device is not None:
        tensor = tensor.to(device)
    return tensor


def tensor2pil(t_image: torch.Tensor) -> Image:
    return Image.fromarray(np.clip(255.0 * t_image.cpu().numpy().squeeze(), 0, 255).astype(np.uint8))