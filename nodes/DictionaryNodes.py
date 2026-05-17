MAX_DICT_COUNT = 10
MAX_KV_PAIRS = 5


class DictionaryUpdate:
    @classmethod
    def INPUT_TYPES(cls):
        base = {
            "required": {
                "dict1": ("DICT", {"lazy": True}),
                "dict2": ("DICT", {"lazy": True}),
            },
            "optional": {},
        }
        for i in range(3, MAX_DICT_COUNT + 1):
            base["optional"][f"dict{i}"] = ("DICT", {"lazy": True})
        return base

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("merged_dict",)
    FUNCTION = "dictionary_update"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def check_lazy_status(self, **kwargs):
        needed = []
        for i in range(1, MAX_DICT_COUNT + 1):
            key = f"dict{i}"
            if key in kwargs and kwargs[key] is None:
                needed.append(key)
        return needed

    def dictionary_update(self, **kwargs):
        merged = {}
        for i in range(1, MAX_DICT_COUNT + 1):
            key = f"dict{i}"
            value = kwargs.get(key)
            if value is not None and isinstance(value, dict):
                merged.update(value)
        return (merged,)


class DictionaryGet:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "dict": ("DICT",),
                "key": ("STRING", {"default": "", "multiline": False}),
            },
            "optional": {
                "default_value": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("value",)
    FUNCTION = "dictionary_get"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def dictionary_get(self, dict, key, default_value=""):
        if not hasattr(dict, 'get'):
            return (str(default_value),)
        return (str(dict.get(key, default_value)),)


class DictionaryNew:
    @classmethod
    def INPUT_TYPES(cls):
        base = {
            "required": {
                "key1": ("STRING", {"default": "", "multiline": False}),
                "value1": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {},
        }
        for i in range(2, MAX_KV_PAIRS + 1):
            base["optional"][f"key{i}"] = ("STRING", {"default": "", "multiline": False})
            base["optional"][f"value{i}"] = ("STRING", {"default": "", "multiline": True})
        return base

    RETURN_TYPES = ("DICT",)
    RETURN_NAMES = ("dict",)
    FUNCTION = "dictionary_new"
    CATEGORY = "❤️‍🩹炮哥Nodes/字典操作"

    def dictionary_new(self, key1="", value1="", **kwargs):
        result = {}
        if key1:
            result[key1] = value1
        for i in range(2, MAX_KV_PAIRS + 1):
            k = kwargs.get(f"key{i}", "")
            v = kwargs.get(f"value{i}", "")
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
