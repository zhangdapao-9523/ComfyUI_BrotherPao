MAX_DICT_COUNT = 10
MAX_KV_PAIRS = 5


class DictionaryUpdate:
    @classmethod
    def INPUT_TYPES(cls):
        base = {
            "required": {
                "字典1": ("DICT", {"lazy": True}),
                "字典2": ("DICT", {"lazy": True}),
            },
            "optional": {},
        }
        for i in range(3, MAX_DICT_COUNT + 1):
            base["optional"][f"字典{i}"] = ("DICT", {"lazy": True})
        return base

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("合并后的字典",)
    FUNCTION = "dictionary_update"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def check_lazy_status(self, **kwargs):
        needed = []
        for i in range(1, MAX_DICT_COUNT + 1):
            key = f"字典{i}"
            if key in kwargs and kwargs[key] is None:
                needed.append(key)
        return needed

    def dictionary_update(self, **kwargs):
        merged = {}
        for i in range(1, MAX_DICT_COUNT + 1):
            key = f"字典{i}"
            value = kwargs.get(key)
            if value is not None and isinstance(value, dict):
                merged.update(value)
        return (merged,)


class DictionaryGet:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "字典": ("DICT",),
                "键": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "默认值": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("值",)
    FUNCTION = "dictionary_get"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def dictionary_get(self, 字典, 键, 默认值=""):
        if not isinstance(字典, dict):
            return (str(默认值),)
        return (str(字典.get(键, 默认值)),)


class DictionaryNew:
    @classmethod
    def INPUT_TYPES(cls):
        base = {
            "required": {
                "键1": ("STRING", {"default": "", "multiline": False}),
                "值1": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {},
        }
        for i in range(2, MAX_KV_PAIRS + 1):
            base["optional"][f"键{i}"] = ("STRING", {"default": "", "multiline": False})
            base["optional"][f"值{i}"] = ("STRING", {"default": "", "multiline": False})
        return base

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("字典",)
    FUNCTION = "dictionary_new"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def dictionary_new(self, 键1, 值1, **kwargs):
        result = {}
        if 键1:
            result[键1] = 值1
        for i in range(2, MAX_KV_PAIRS + 1):
            k = kwargs.get(f"键{i}", "")
            v = kwargs.get(f"值{i}", "")
            if k:
                result[k] = v
        return (result,)


NODE_CLASS_MAPPINGS = {
    'BrotherPao_DictionaryUpdate': DictionaryUpdate,
    'BrotherPao_DictionaryGet': DictionaryGet,
    'BrotherPao_DictionaryNew': DictionaryNew,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    'BrotherPao_DictionaryUpdate': '字典合并',
    'BrotherPao_DictionaryGet': '字典取值',
    'BrotherPao_DictionaryNew': '新建字典',
}
