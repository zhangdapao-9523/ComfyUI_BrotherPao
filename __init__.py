import importlib

WEB_DIRECTORY = "web"

try:
    from .nodes import comfy_entrypoint
except ImportError:
    comfy_entrypoint = None

try:
    importlib.import_module('.routes', __name__)
except ImportError:
    pass

__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
